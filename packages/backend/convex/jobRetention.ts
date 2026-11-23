// Retention for finished jobs and their logs. Two sweeps walk their tables
// in creation order from a stored cursor, a small batch per mutation, chained
// from an hourly cron:
// - jobs: a finished job with no deployment row (inspections, status checks,
//   clean-ups, monitoring setup, update checks, ...) is deleted with its log
//   once it finished more than HOUSEKEEPING_RETENTION_MS ago (looked at a
//   day after that, counted from its creation);
// - deployments: each target keeps its newest DEPLOYMENT_HISTORY_KEEP
//   deployment rows; older ones go with their job and log, like "Clear
//   history" does.
// Jobs other code still reads are never deleted (`keptJobs`).
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	internalMutation,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server";
import { REDEPLOY_SCAN } from "./serviceEvents";

export const HOUSEKEEPING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEPLOYMENT_HISTORY_KEEP = 100;

// The sweep visits a job a day after the retention period from its creation,
// so one that ran for a while has finished by then; one still not older than
// the period is kept and looked at again later (LOOK_BACK).
const VISIT_DELAY_MS = 24 * 60 * 60 * 1000;
const JOB_BATCH = 20;
const DEPLOYMENT_BATCH = 10;
// Jobs of the same group and kind looked at again before each visited one:
// a job kept as the newest of its kind becomes deletable once a newer one
// exists, and the sweep has already passed it by then.
const LOOK_BACK = 5;
const TRIM_BATCH = 25;
const LOG_PURGE_BATCH = 50;
// Batches one cron run may chain; the rest waits for the next hour, so a
// large backlog (rows from before retention existed) is worked off
// gradually.
const MAX_ROUNDS = 100;

// Groups named after a one-off operation: nothing reads their jobs once
// they are old, so the newest of the group is not kept for its own sake.
const ONE_OFF_GROUPS = ["databaseOp:", "sandbox:"];

const FINISHED = ["succeeded", "failed", "cancelled"] as const;
const STATUSES = ["queued", "running", ...FINISHED] as const;

type Pair = { group: string; kind: Doc<"jobs">["spec"]["kind"] };

const pairOf = (job: Doc<"jobs">): Pair => ({
	group: job.group,
	kind: job.spec.kind,
});

const pairKey = ({ group, kind }: Pair) => `${group}\u0000${kind}`;

const ofPair = (
	ctx: QueryCtx,
	{ group, kind }: Pair,
	status: Doc<"jobs">["status"],
	createdBefore?: number,
) =>
	ctx.db.query("jobs").withIndex("by_group_and_kind_and_status", (q) => {
		const range = q
			.eq("group", group)
			.eq("spec.kind", kind)
			.eq("status", status);
		return createdBefore === undefined
			? range
			: range.lt("_creationTime", createdBefore);
	});

// The jobs of a group and kind other code still reads, whatever their age:
// - the newest one, whatever its status: a service's or host's "last job"
//   (monitoring, access log and telemetry settings point at it; lists show
//   it);
// - the newest successful ones: a service's pending changes and "deployed
//   yet" check replay them (`serviceEvents.ts`, `lib/serviceActivity.ts`).
const keptJobs = async (
	ctx: QueryCtx,
	pair: Pair,
): Promise<Set<Id<"jobs">>> => {
	const kept = new Set<Id<"jobs">>();
	const succeeded = await ofPair(ctx, pair, "succeeded")
		.order("desc")
		.take(pair.kind === "application.redeploy" ? REDEPLOY_SCAN : 1);
	for (const job of succeeded) kept.add(job._id);
	if (ONE_OFF_GROUPS.some((prefix) => pair.group.startsWith(prefix))) {
		return kept;
	}
	let newest: Doc<"jobs"> | null = null;
	for (const status of STATUSES) {
		const job = await ofPair(ctx, pair, status).order("desc").first();
		if (job && (!newest || job._creationTime > newest._creationTime)) {
			newest = job;
		}
	}
	if (newest) kept.add(newest._id);
	return kept;
};

// The Updates dialog shows the last panel update's outcome however old.
const isPanelUpdate = (job: Doc<"jobs">) =>
	job.spec.kind === "infra.panelAction" && job.spec.action.type === "update";

const hasDeployment = async (ctx: QueryCtx, jobId: Id<"jobs">) =>
	(await ctx.db
		.query("deployments")
		.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
		.first()) !== null;

const readCursor = async (ctx: MutationCtx, name: string) =>
	await ctx.db
		.query("housekeepingCursors")
		.withIndex("by_name", (q) => q.eq("name", name))
		.unique();

const moveCursor = async (
	ctx: MutationCtx,
	cursor: Doc<"housekeepingCursors"> | null,
	name: string,
	position: number,
) => {
	if (cursor) {
		await ctx.db.patch("housekeepingCursors", cursor._id, { position });
	} else {
		await ctx.db.insert("housekeepingCursors", { name, position });
	}
};

const deleteJob = async (ctx: MutationCtx, job: Doc<"jobs">) => {
	const leases = await ctx.db
		.query("jobLeases")
		.withIndex("by_jobId", (q) => q.eq("jobId", job._id))
		.take(10);
	for (const lease of leases) await ctx.db.delete("jobLeases", lease._id);
	await ctx.db.delete("jobs", job._id);
};

// A housekeeping job that may go: finished before the cutoff, not kept for
// other code, and not part of a deployment history (those are trimmed by
// count instead).
const prunable = async (
	ctx: QueryCtx,
	job: Doc<"jobs">,
	kept: Set<Id<"jobs">>,
	cutoff: number,
) =>
	(FINISHED as readonly string[]).includes(job.status) &&
	(job.finishedAt ?? job._creationTime) < cutoff &&
	!kept.has(job._id) &&
	!isPanelUpdate(job) &&
	!(await hasDeployment(ctx, job._id));

const sweepJobs = async (ctx: MutationCtx, now: number) => {
	const cutoff = now - HOUSEKEEPING_RETENTION_MS;
	const cursor = await readCursor(ctx, "jobs");
	const batch = await ctx.db
		.query("jobs")
		.withIndex("by_creation_time", (q) =>
			q
				.gt("_creationTime", cursor?.position ?? 0)
				.lt("_creationTime", cutoff - VISIT_DELAY_MS),
		)
		.take(JOB_BATCH);
	const keptByPair = new Map<string, Set<Id<"jobs">>>();
	const deleted = new Set<Id<"jobs">>();
	for (const job of batch) {
		const pair = pairOf(job);
		const key = pairKey(pair);
		let kept = keptByPair.get(key);
		if (!kept) {
			kept = await keptJobs(ctx, pair);
			keptByPair.set(key, kept);
		}
		const candidates = [job];
		for (const status of FINISHED) {
			candidates.push(
				...(await ofPair(ctx, pair, status, job._creationTime)
					.order("desc")
					.take(LOOK_BACK)),
			);
		}
		for (const candidate of candidates) {
			if (deleted.has(candidate._id)) continue;
			if (!(await prunable(ctx, candidate, kept, cutoff))) continue;
			await deleteJob(ctx, candidate);
			deleted.add(candidate._id);
		}
	}
	const last = batch.at(-1);
	if (last) await moveCursor(ctx, cursor, "jobs", last._creationTime);
	return { done: batch.length < JOB_BATCH, deleted: [...deleted] };
};

// An application's stored versions (read once per target): the ones that
// point at a deleted deployment lose the link, as with "Clear history".
const applicationRollbacks = async (
	ctx: MutationCtx,
	target: Doc<"deployments">["target"],
) => {
	if (target.kind !== "application") return [];
	const applicationId = ctx.db.normalizeId("applications", target.id);
	if (!applicationId) return [];
	return await ctx.db
		.query("applicationRollbacks")
		.withIndex("by_applicationId_and_version", (q) =>
			q.eq("applicationId", applicationId),
		)
		.take(100);
};

// Deletes the rows of a target beyond its newest DEPLOYMENT_HISTORY_KEEP,
// with their jobs, except unfinished jobs and the ones other code reads.
const trimTarget = async (
	ctx: MutationCtx,
	target: Doc<"deployments">["target"],
): Promise<Id<"jobs">[]> => {
	const rows = await ctx.db
		.query("deployments")
		.withIndex("by_target", (q) =>
			q.eq("target.kind", target.kind).eq("target.id", target.id),
		)
		.order("desc")
		.take(DEPLOYMENT_HISTORY_KEEP + TRIM_BATCH);
	const deleted: Id<"jobs">[] = [];
	const keptByPair = new Map<string, Set<Id<"jobs">>>();
	let rollbacks: Doc<"applicationRollbacks">[] | null = null;
	for (const row of rows.slice(DEPLOYMENT_HISTORY_KEEP)) {
		const job = await ctx.db.get("jobs", row.jobId);
		if (job) {
			if (!(FINISHED as readonly string[]).includes(job.status)) continue;
			const key = pairKey(pairOf(job));
			let kept = keptByPair.get(key);
			if (!kept) {
				kept = await keptJobs(ctx, pairOf(job));
				keptByPair.set(key, kept);
			}
			if (kept.has(job._id)) continue;
		}
		rollbacks ??= await applicationRollbacks(ctx, target);
		for (const rollback of rollbacks) {
			if (rollback.deploymentId === row._id) {
				await ctx.db.patch("applicationRollbacks", rollback._id, {
					deploymentId: undefined,
				});
			}
		}
		await ctx.db.delete("deployments", row._id);
		if (job) {
			await deleteJob(ctx, job);
			deleted.push(job._id);
		}
	}
	return deleted;
};

const sweepDeployments = async (ctx: MutationCtx) => {
	const cursor = await readCursor(ctx, "deployments");
	const batch = await ctx.db
		.query("deployments")
		.withIndex("by_creation_time", (q) =>
			q.gt("_creationTime", cursor?.position ?? 0),
		)
		.take(DEPLOYMENT_BATCH);
	const targets = new Map(
		batch.map((row) => [`${row.target.kind}:${row.target.id}`, row.target]),
	);
	const deleted: Id<"jobs">[] = [];
	for (const target of targets.values()) {
		deleted.push(...(await trimTarget(ctx, target)));
	}
	const last = batch.at(-1);
	if (last) await moveCursor(ctx, cursor, "deployments", last._creationTime);
	return { done: batch.length < DEPLOYMENT_BATCH, deleted };
};

const phase = v.union(v.literal("jobs"), v.literal("deployments"));

// One batch of the current sweep; chains itself until both sweeps caught up
// or the round budget of this run is spent.
export const prune = internalMutation({
	args: {
		phase: v.optional(phase),
		round: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const current = args.phase ?? "jobs";
		const round = args.round ?? 0;
		const { done, deleted } =
			current === "jobs"
				? await sweepJobs(ctx, Date.now())
				: await sweepDeployments(ctx);
		if (deleted.length > 0) {
			await ctx.scheduler.runAfter(0, internal.jobRetention.purgeLogs, {
				jobIds: deleted,
			});
		}
		const next = !done ? current : current === "jobs" ? "deployments" : null;
		if (next && round + 1 < MAX_ROUNDS) {
			await ctx.scheduler.runAfter(0, internal.jobRetention.prune, {
				phase: next,
				round: round + 1,
			});
		}
		return { phase: current, deleted: deleted.length, done };
	},
});

// Log chunks can be up to 64 KiB each, so a deleted job's log goes a few
// chunks per mutation.
export const purgeLogs = internalMutation({
	args: { jobIds: v.array(v.id("jobs")) },
	handler: async (ctx, { jobIds }) => {
		const [jobId, ...rest] = jobIds;
		if (!jobId) return;
		const chunks = await ctx.db
			.query("jobLogChunks")
			.withIndex("by_jobId_and_seq", (q) => q.eq("jobId", jobId))
			.take(LOG_PURGE_BATCH);
		for (const chunk of chunks) await ctx.db.delete("jobLogChunks", chunk._id);
		const next = chunks.length === LOG_PURGE_BATCH ? jobIds : rest;
		if (next.length > 0) {
			await ctx.scheduler.runAfter(0, internal.jobRetention.purgeLogs, {
				jobIds: next,
			});
		}
	},
});
