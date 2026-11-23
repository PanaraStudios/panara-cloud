import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import { getRootOrganizationId } from "./infra/access";
import { requireAgent } from "./lib/agentAuth";
import { LEASE_MS } from "./lib/jobs";
import { finishJob, noteLateCancel, requireLease } from "./lib/lease";
import { errorIsCancel } from "./lib/serviceStatus";
import { resolveHostTarget } from "./lib/targets";
import { applyToggle } from "./live/accessLog";
import { LOCAL_PARTITION } from "./schema";
import { volumeRemoval } from "./tables/core";

const CLAIM_PAGE = 100;
const CLAIM_SCAN_BUDGET = 1_000;
const MAX_RUNNING_SCAN = 200;
// The agent's worker pool is shared by every organization: one other than
// the root organization runs at most this many jobs at once (quick jobs
// apart), so its slow or hung jobs can't take every slot.
export const MAX_RUNNING_PER_ORG = 2;
export const MAX_QUICK_RUNNING_PER_ORG = 1;
// Jobs of organizations other than the root one are cancelled after this
// long (quick jobs much sooner); the heartbeat that finds one overdue asks
// for the cancel.
export const JOB_DEADLINE_MS = 3 * 60 * 60 * 1000;
export const QUICK_JOB_DEADLINE_MS = 10 * 60 * 1000;
const MAX_LOG_CHUNK_CHARS = 64 * 1024;
const MAX_LOG_CHUNKS_PER_CALL = 50;

// Short jobs behind interactive pages (Docker lists and container/image/
// volume actions, Traefik files, mount files, S3 checks). The agent keeps a
// few slots for these so a page doesn't wait for deploys and builds to finish.
export const QUICK_JOB_KINDS: ReadonlySet<string> = new Set([
	"infra.inspect",
	"infra.dockerAction",
	"infra.traefikFiles",
	"infra.readMountFile",
	"infra.probeAddresses",
	"infra.publicIp",
	"databases.testDestination",
	"databases.listBackupFiles",
]);

const jobResult = v.union(
	v.object({
		kind: v.literal("server.validate"),
		ok: v.boolean(),
		details: v.string(),
	}),
	v.object({
		kind: v.literal("volumes.removal"),
		...volumeRemoval.fields,
	}),
	v.object({ kind: v.literal("none") }),
);

const MAX_REPORTED_VOLUMES = 200;

export const hello = mutation({
	args: { version: v.string(), capabilities: v.array(v.string()) },
	handler: async (ctx, { version, capabilities }) => {
		const agent = await requireAgent(ctx);
		const presence = await ctx.db
			.query("agentPresence")
			.withIndex("by_agentId", (q) => q.eq("agentId", agent._id))
			.unique();
		const fields = { lastSeenAt: Date.now(), version, capabilities };
		if (presence) {
			await ctx.db.patch("agentPresence", presence._id, fields);
		} else {
			await ctx.db.insert("agentPresence", { agentId: agent._id, ...fields });
		}
		return { agentId: agent._id, leaseMs: LEASE_MS };
	},
});

const partitionLimit = async (
	ctx: QueryCtx,
	partition: string,
): Promise<number> => {
	if (partition === LOCAL_PARTITION) {
		const settings = await ctx.db
			.query("instanceSettings")
			.withIndex("by_key", (q) => q.eq("key", "instance"))
			.unique();
		return Math.max(1, settings?.localBuildsConcurrency ?? 1);
	}
	const serverId = ctx.db.normalizeId("servers", partition);
	const server = serverId ? await ctx.db.get("servers", serverId) : null;
	return Math.max(1, server?.buildsConcurrency ?? 1);
};

const isQuick = (job: Doc<"jobs">) => QUICK_JOB_KINDS.has(job.spec.kind);

// The queue as claimNext sees it: queued jobs oldest first, at most
// CLAIM_SCAN_BUDGET of them, and whether each one may start now. Jobs that
// must wait (their group, partition or organization is busy) don't hide the
// ones behind them. Shared by claimNext and the `claimable` query the agent
// subscribes to, so the two never disagree; reads are lazy and remembered,
// so a query that runs it reads only the rows that decide its answer.
const claimScan = (ctx: QueryCtx) => {
	let root: Promise<string | null> | undefined;
	const fullPartitions = new Map<string, Promise<boolean>>();
	const busyGroups = new Map<string, Promise<boolean>>();
	const busyOrganizations = new Map<string, Promise<boolean>>();

	const remember = (
		cache: Map<string, Promise<boolean>>,
		key: string,
		read: () => Promise<boolean>,
	) => {
		let value = cache.get(key);
		if (!value) {
			value = read();
			cache.set(key, value);
		}
		return value;
	};

	// Counted before the limit is read: a partition with no build running
	// has a free slot whatever its limit, and the server row stays out of
	// the read set.
	const partitionFull = (partition: string) =>
		remember(fullPartitions, partition, async () => {
			const running = await ctx.db
				.query("jobs")
				.withIndex("by_partition_and_status", (q) =>
					q.eq("partition", partition).eq("status", "running"),
				)
				.take(MAX_RUNNING_SCAN);
			const buildsRunning = running.filter((r) => r.usesBuildSlot).length;
			if (buildsRunning === 0) return false;
			return buildsRunning >= (await partitionLimit(ctx, partition));
		});

	const groupBusy = (group: string) =>
		remember(busyGroups, group, async () => {
			const running = await ctx.db
				.query("jobs")
				.withIndex("by_group_and_status", (q) =>
					q.eq("group", group).eq("status", "running"),
				)
				.first();
			return running !== null;
		});

	// Whether the organization already runs its share of the pool.
	const organizationFull = (organizationId: string, quick: boolean) =>
		remember(busyOrganizations, `${organizationId}:${quick}`, async () => {
			root ??= getRootOrganizationId(ctx);
			if (organizationId === (await root)) return false;
			const limit = quick ? MAX_QUICK_RUNNING_PER_ORG : MAX_RUNNING_PER_ORG;
			const running = await ctx.db
				.query("jobs")
				.withIndex("by_organizationId_and_status", (q) =>
					q.eq("organizationId", organizationId).eq("status", "running"),
				)
				.take(MAX_RUNNING_SCAN);
			return running.filter((r) => isQuick(r) === quick).length >= limit;
		});

	const canStart = async (job: Doc<"jobs">): Promise<boolean> => {
		if (job.usesBuildSlot && (await partitionFull(job.partition))) {
			return false;
		}
		if (await groupBusy(job.group)) return false;
		return !(await organizationFull(job.organizationId, isQuick(job)));
	};

	async function* queued(): AsyncGenerator<Doc<"jobs">> {
		let after: number | null = null;
		for (let scanned = 0; scanned < CLAIM_SCAN_BUDGET; ) {
			const cursor: number | null = after;
			const page: Doc<"jobs">[] = await ctx.db
				.query("jobs")
				.withIndex("by_status", (q) =>
					cursor === null
						? q.eq("status", "queued")
						: q.eq("status", "queued").gt("_creationTime", cursor),
				)
				.take(CLAIM_PAGE);
			scanned += page.length;
			yield* page;
			if (page.length < CLAIM_PAGE) return;
			after = page[page.length - 1]?._creationTime ?? null;
		}
	}

	return { canStart, queued };
};

// Kept for agents before 0.1.6, which subscribe to this and poll every 15 s.
export const hasQueuedJobs = query({
	args: {},
	handler: async (ctx) => {
		await requireAgent(ctx);
		const next = await ctx.db
			.query("jobs")
			.withIndex("by_status", (q) => q.eq("status", "queued"))
			.first();
		return next !== null;
	},
});

// What the agent subscribes to instead of polling: the job claimNext would
// take now (`next`) and the one claimNext({ quickOnly }) would take
// (`nextQuick`), or null. It changes only when work becomes claimable or is
// taken. Its read set: this agent's row, the queued range of `by_status` up
// to the first claimable job (all of it, at most CLAIM_SCAN_BUDGET rows,
// when nothing can start) and, for each queued job it looks at, the running
// jobs of its group, of its partition (plus the server's limit once a build
// runs there) and of its organization. Logs, leases, heartbeats, finished
// jobs and service rows are not in it.
export const claimable = query({
	args: {},
	handler: async (ctx) => {
		await requireAgent(ctx);
		const scan = claimScan(ctx);
		let next: Id<"jobs"> | null = null;
		for await (const job of scan.queued()) {
			const quick = isQuick(job);
			if (next !== null && !quick) continue;
			if (!(await scan.canStart(job))) continue;
			next ??= job._id;
			if (quick) return { next, nextQuick: job._id };
		}
		return { next, nextQuick: null };
	},
});

// The jobs this agent runs whose cancel was asked for. The agent subscribes
// to this, so a cancel reaches it as soon as it is written rather than with
// the next heartbeat. Reads only this agent's running jobs: lease renewals
// and log writes don't touch them.
export const cancelRequests = query({
	args: {},
	handler: async (ctx) => {
		const agent = await requireAgent(ctx);
		const running = await ctx.db
			.query("jobs")
			.withIndex("by_claimedBy_and_status", (q) =>
				q.eq("claimedBy", agent._id).eq("status", "running"),
			)
			.take(MAX_RUNNING_SCAN);
		return running.filter((job) => job.cancelRequested).map((job) => job._id);
	},
});

export const claimNext = mutation({
	args: { quickOnly: v.optional(v.boolean()) },
	handler: async (ctx, { quickOnly }) => {
		const agent = await requireAgent(ctx);
		const scan = claimScan(ctx);
		for await (const job of scan.queued()) {
			if (quickOnly && !isQuick(job)) continue;
			if (!(await scan.canStart(job))) continue;
			const now = Date.now();
			const leaseId = crypto.randomUUID();
			await ctx.db.patch("jobs", job._id, {
				status: "running",
				attempts: job.attempts + 1,
				claimedBy: agent._id,
				startedAt: now,
			});
			await ctx.db.insert("jobLeases", {
				jobId: job._id,
				agentId: agent._id,
				leaseId,
				expiresAt: now + LEASE_MS,
			});
			return {
				jobId: job._id,
				leaseId,
				organizationId: job.organizationId,
				partition: job.partition,
				spec: job.spec,
				attempt: job.attempts + 1,
			};
		}
		return null;
	},
});

export const heartbeat = mutation({
	args: { jobId: v.id("jobs"), leaseId: v.string() },
	handler: async (ctx, { jobId, leaseId }) => {
		const { job, lease } = await requireLease(ctx, jobId, leaseId);
		const now = Date.now();
		await ctx.db.patch("jobLeases", lease._id, {
			expiresAt: now + LEASE_MS,
		});
		const deadline = QUICK_JOB_KINDS.has(job.spec.kind)
			? QUICK_JOB_DEADLINE_MS
			: JOB_DEADLINE_MS;
		if (
			!job.cancelRequested &&
			job.startedAt !== undefined &&
			now - job.startedAt > deadline &&
			job.organizationId !== (await getRootOrganizationId(ctx))
		) {
			await ctx.db.patch("jobs", job._id, { cancelRequested: true });
			return { cancelRequested: true };
		}
		return { cancelRequested: job.cancelRequested };
	},
});

export const appendLogs = mutation({
	args: {
		jobId: v.id("jobs"),
		leaseId: v.string(),
		chunks: v.array(v.object({ seq: v.number(), text: v.string() })),
	},
	handler: async (ctx, { jobId, leaseId, chunks }) => {
		await requireLease(ctx, jobId, leaseId);
		if (chunks.length > MAX_LOG_CHUNKS_PER_CALL) {
			throw new ConvexError("Too many log chunks in one call");
		}
		for (const chunk of chunks) {
			if (chunk.text.length > MAX_LOG_CHUNK_CHARS) {
				throw new ConvexError("Log chunk too large");
			}
			const existing = await ctx.db
				.query("jobLogChunks")
				.withIndex("by_jobId_and_seq", (q) =>
					q.eq("jobId", jobId).eq("seq", chunk.seq),
				)
				.first();
			if (!existing) {
				await ctx.db.insert("jobLogChunks", { jobId, ...chunk });
			}
		}
	},
});

const applyResult = async (
	ctx: MutationCtx,
	job: Doc<"jobs">,
	result: typeof jobResult.type,
) => {
	if (
		result.kind === "server.validate" &&
		job.spec.kind === "server.validate"
	) {
		const server = await ctx.db.get("servers", job.spec.serverId);
		if (server) {
			await ctx.db.patch("servers", server._id, {
				lastValidation: {
					ok: result.ok,
					details: result.details,
					checkedAt: Date.now(),
				},
			});
		}
	}
	if (result.kind === "volumes.removal") {
		await ctx.db.patch("jobs", job._id, {
			volumeRemoval: {
				removed: result.removed.slice(0, MAX_REPORTED_VOLUMES),
				kept: result.kept
					.slice(0, MAX_REPORTED_VOLUMES)
					.map((kept) => ({ ...kept, reason: kept.reason.slice(0, 500) })),
			},
		});
	}
};

// The agent calls `complete` only when the handler finished its work; a
// cancel that took effect aborts the handler, which the agent reports with
// `fail`. So a completed job succeeded even when a cancel was asked for
// meanwhile: the record says what happened on the host (the new container is
// up), and its log says the cancel came too late. This holds for every kind
// of job, since they all end here.
export const complete = mutation({
	args: { jobId: v.id("jobs"), leaseId: v.string(), result: jobResult },
	handler: async (ctx, { jobId, leaseId, result }) => {
		await requireAgent(ctx);
		const job = await ctx.db.get("jobs", jobId);
		// Completing twice (e.g. a retried request) is a no-op.
		if (job?.status !== "running") return;
		const { lease } = await requireLease(ctx, jobId, leaseId);
		await applyResult(ctx, job, result);
		await applyToggle(ctx, job);
		if (job.cancelRequested) await noteLateCancel(ctx, job._id);
		await finishJob(ctx, job, lease, { status: "succeeded" });
	},
});

export const fail = mutation({
	args: {
		jobId: v.id("jobs"),
		leaseId: v.string(),
		error: v.string(),
		result: v.optional(jobResult),
		despiteCancel: v.optional(v.boolean()),
	},
	handler: async (ctx, { jobId, leaseId, error, result, despiteCancel }) => {
		await requireAgent(ctx);
		const job = await ctx.db.get("jobs", jobId);
		if (job?.status !== "running") return;
		const { lease } = await requireLease(ctx, jobId, leaseId);
		if (result) await applyResult(ctx, job, result);
		await finishJob(ctx, job, lease, {
			status: errorIsCancel(job, despiteCancel) ? "cancelled" : "failed",
			error: error.slice(0, 4000),
		});
	},
});

// An agent that is shutting down hands back the jobs it couldn't finish in
// its drain window: the same retry rule as lease expiry, but settled right
// away and with an error that says what happened.
export const release = mutation({
	args: { jobId: v.id("jobs"), leaseId: v.string(), reason: v.string() },
	handler: async (ctx, { jobId, leaseId, reason }) => {
		await requireAgent(ctx);
		const job = await ctx.db.get("jobs", jobId);
		if (job?.status !== "running") return { requeued: false };
		const { lease } = await requireLease(ctx, jobId, leaseId);
		if (
			job.idempotent &&
			!job.cancelRequested &&
			job.attempts < job.maxAttempts
		) {
			await ctx.db.delete("jobLeases", lease._id);
			await ctx.db.patch("jobs", jobId, {
				status: "queued",
				claimedBy: undefined,
				startedAt: undefined,
			});
			return { requeued: true };
		}
		await finishJob(ctx, job, lease, {
			status: job.cancelRequested ? "cancelled" : "failed",
			error: reason.slice(0, 4000),
		});
		return { requeued: false };
	},
});

const HOST_KEY_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

// Trust on first use: the first fingerprint the agent sees for a server is
// kept; later ones never replace it (an admin resets it from the server
// settings with servers.resetHostKey).
export const recordHostKey = mutation({
	args: { serverId: v.id("servers"), fingerprint: v.string() },
	handler: async (ctx, { serverId, fingerprint }) => {
		await requireAgent(ctx);
		if (!HOST_KEY_FINGERPRINT.test(fingerprint)) {
			throw new ConvexError("Invalid host key fingerprint");
		}
		const server = await ctx.db.get("servers", serverId);
		if (!server) return { recorded: false, matches: true };
		if (server.sshHostKey) {
			return { recorded: false, matches: server.sshHostKey === fingerprint };
		}
		await ctx.db.patch("servers", serverId, { sshHostKey: fingerprint });
		return { recorded: true, matches: true };
	},
});

// Resolves how to reach the job's target server, including the decrypted SSH
// key. Only valid while the agent holds the lease.
export const getJobTarget = query({
	args: { jobId: v.id("jobs"), leaseId: v.string() },
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		return await resolveHostTarget(ctx, job.partition);
	},
});
