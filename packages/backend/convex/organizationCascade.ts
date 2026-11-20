import { type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { onServerRemoved } from "./infra/cleanup";
import { PROJECT_ENV_KIND } from "./lib/env";
import { deleteSecret } from "./lib/secrets";
import { revokeLiveSessions } from "./live/revoke";
import { enqueueVectorReconcile } from "./platform/telemetry";

// Removes everything an organization owns once Better Auth deleted it (the
// `organization.onDelete` trigger in auth.ts starts it). Each run handles
// one bounded batch and schedules the next, phase by phase:
//   projects  delete projects; their environments and services cascade
//             through the existing scheduled helpers (which enqueue the
//             agent jobs that remove containers from the servers)
//   services  wait until those cascades and their agent jobs are done, so
//             the jobs can still resolve the servers they run on
//   servers   delete servers with the server cascade
//   sweep     delete every remaining row keyed by the organization
//   jobs      delete the organization's jobs with logs, leases and results
//   secrets   delete whatever ciphertext is left

const BATCH = 100;
const PROJECT_BATCH = 20;
const SERVER_BATCH = 10;
const JOB_PAGE = 20;
const LOG_CHUNK_BATCH = 200;
const ACTIVE_JOB_PROBE = 200;
export const WAIT_MS = 30_000;
// About ten minutes for the agent to finish removal jobs before rows are
// deleted regardless.
export const MAX_WAITS = 20;

const phase = v.union(
	v.literal("projects"),
	v.literal("services"),
	v.literal("servers"),
	v.literal("sweep"),
	v.literal("jobs"),
	v.literal("secrets"),
);

type Phase = Infer<typeof phase>;

type Next =
	| { phase: Phase; step?: number; cursor?: string | null; attempt?: number }
	| { delayMs: number; phase: Phase; attempt: number }
	| null;

const cancelScheduled = async (
	ctx: MutationCtx,
	id: Id<"_scheduled_functions"> | undefined,
) => {
	if (!id) return;
	const pending = await ctx.db.system
		.get("_scheduled_functions", id)
		.catch(() => null);
	if (pending?.state.kind === "pending") await ctx.scheduler.cancel(id);
};

const removeProjects = async (
	ctx: MutationCtx,
	organizationId: string,
): Promise<Next> => {
	// Before rows go: end the organization's live streams, and empty its
	// Vector agents so the agent removes them (the panel host's one keeps
	// shipping host metrics otherwise).
	await revokeLiveSessions(ctx, { organizationId });
	const vectorTargets = await ctx.db
		.query("vectorTargets")
		.withIndex("by_organizationId", (q) =>
			q.eq("organizationId", organizationId),
		)
		.take(BATCH);
	for (const target of vectorTargets) {
		if (target.providerIds.length === 0) continue;
		await ctx.db.patch("vectorTargets", target._id, { providerIds: [] });
		await enqueueVectorReconcile(ctx, { ...target, providerIds: [] });
	}
	const projects = await ctx.db
		.query("projects")
		.withIndex("by_organizationId", (q) =>
			q.eq("organizationId", organizationId),
		)
		.take(PROJECT_BATCH);
	for (const project of projects) {
		await ctx.db.delete("projects", project._id);
		await ctx.scheduler.runAfter(0, internal.projects.deleteEnvironments, {
			projectId: project._id,
		});
		await ctx.scheduler.runAfter(0, internal.platform.tags.removeProjectLinks, {
			projectId: project._id,
		});
		await deleteSecret(ctx, PROJECT_ENV_KIND, project._id);
	}
	return projects.length === PROJECT_BATCH
		? { phase: "projects" }
		: { phase: "services", attempt: 0 };
};

const hasActiveJobs = async (ctx: MutationCtx, organizationId: string) => {
	// Removal jobs were just enqueued, so the newest jobs are the ones to check.
	const recent = await ctx.db
		.query("jobs")
		.withIndex("by_organizationId", (q) =>
			q.eq("organizationId", organizationId),
		)
		.order("desc")
		.take(ACTIVE_JOB_PROBE);
	return recent.some((j) => j.status === "queued" || j.status === "running");
};

const waitForServices = async (
	ctx: MutationCtx,
	organizationId: string,
	attempt: number,
): Promise<Next> => {
	const byOrg = (table: "applications" | "compose" | "databases") =>
		ctx.db
			.query(table)
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.first();
	const busy =
		(await byOrg("applications")) !== null ||
		(await byOrg("compose")) !== null ||
		(await byOrg("databases")) !== null ||
		(await hasActiveJobs(ctx, organizationId));
	if (busy && attempt < MAX_WAITS) {
		return { delayMs: WAIT_MS, phase: "services", attempt: attempt + 1 };
	}
	return { phase: "servers" };
};

const removeServers = async (
	ctx: MutationCtx,
	organizationId: string,
): Promise<Next> => {
	const servers = await ctx.db
		.query("servers")
		.withIndex("by_organizationId", (q) =>
			q.eq("organizationId", organizationId),
		)
		.take(SERVER_BATCH);
	for (const server of servers) {
		await ctx.db.delete("servers", server._id);
		await onServerRemoved(ctx, server);
		await ctx.scheduler.runAfter(0, internal.live.cleanup.removeForServer, {
			serverId: server._id,
		});
		await ctx.scheduler.runAfter(
			0,
			internal.platform.schedules.removeForTarget,
			{ targetId: server._id },
		);
		const targets = await ctx.db
			.query("vectorTargets")
			.withIndex("by_serverId", (q) => q.eq("serverId", server._id))
			.take(BATCH);
		for (const target of targets) {
			await ctx.db.delete("vectorTargets", target._id);
		}
	}
	return servers.length === SERVER_BATCH
		? { phase: "servers" }
		: { phase: "sweep", step: 0 };
};

// One step per table. A step deletes up to BATCH rows (children first) and
// returns whether rows may remain, in which case it runs again.
type SweepStep = (ctx: MutationCtx, organizationId: string) => Promise<boolean>;

const full = (rows: unknown[]) => rows.length === BATCH;

const sweepSteps: SweepStep[] = [
	async (ctx, org) => {
		const rows = await ctx.db
			.query("applications")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) {
			if (row.source?.type === "drop" && row.source.storageId) {
				await ctx.storage.delete(row.source.storageId).catch(() => {});
			}
			await ctx.db.delete("applications", row._id);
		}
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("compose")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) await ctx.db.delete("compose", row._id);
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("databases")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) await ctx.db.delete("databases", row._id);
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("domains")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) await ctx.db.delete("domains", row._id);
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("certificates")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) {
			const chains = await ctx.db
				.query("certificateChains")
				.withIndex("by_certificateId", (q) => q.eq("certificateId", row._id))
				.take(BATCH);
			for (const chain of chains) {
				await ctx.db.delete("certificateChains", chain._id);
			}
			if (full(chains)) return true;
			await ctx.db.delete("certificates", row._id);
		}
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("networks")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) await ctx.db.delete("networks", row._id);
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("sshKeys")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) await ctx.db.delete("sshKeys", row._id);
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("databaseBackups")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) {
			await cancelScheduled(ctx, row.scheduledFunctionId);
			await ctx.db.delete("databaseBackups", row._id);
		}
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("volumeBackups")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) {
			await cancelScheduled(ctx, row.scheduledFunctionId);
			await ctx.db.delete("volumeBackups", row._id);
		}
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("panelBackups")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) {
			await cancelScheduled(ctx, row.scheduledFunctionId);
			await ctx.db.delete("panelBackups", row._id);
		}
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("destinations")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) await ctx.db.delete("destinations", row._id);
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("schedules")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) {
			await cancelScheduled(ctx, row.scheduledFunctionId);
			const script = await ctx.db
				.query("scheduleScripts")
				.withIndex("by_scheduleId", (q) => q.eq("scheduleId", row._id))
				.unique();
			if (script) await ctx.db.delete("scheduleScripts", script._id);
			await ctx.db.delete("schedules", row._id);
		}
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("notifications")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) await ctx.db.delete("notifications", row._id);
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("apiKeys")
			.withIndex("by_organizationId_and_userId", (q) =>
				q.eq("organizationId", org),
			)
			.take(BATCH);
		for (const row of rows) {
			const counter = await ctx.db
				.query("apiRateLimits")
				.withIndex("by_key", (q) => q.eq("key", row._id))
				.unique();
			if (counter) await ctx.db.delete("apiRateLimits", counter._id);
			await ctx.db.delete("apiKeys", row._id);
		}
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("tags")
			.withIndex("by_organizationId_and_name", (q) =>
				q.eq("organizationId", org),
			)
			.take(BATCH);
		for (const row of rows) {
			const links = await ctx.db
				.query("projectTags")
				.withIndex("by_tagId", (q) => q.eq("tagId", row._id))
				.take(BATCH);
			for (const link of links) await ctx.db.delete("projectTags", link._id);
			if (full(links)) return true;
			await ctx.db.delete("tags", row._id);
		}
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("templateBookmarks")
			.withIndex("by_organizationId_and_userId_and_templateId", (q) =>
				q.eq("organizationId", org),
			)
			.take(BATCH);
		for (const row of rows) await ctx.db.delete("templateBookmarks", row._id);
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("aiSettings")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) await ctx.db.delete("aiSettings", row._id);
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("vaultProviders")
			.withIndex("by_organizationId_and_name", (q) =>
				q.eq("organizationId", org),
			)
			.take(BATCH);
		for (const row of rows) await ctx.db.delete("vaultProviders", row._id);
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("dnsProviders")
			.withIndex("by_organizationId_and_name", (q) =>
				q.eq("organizationId", org),
			)
			.take(BATCH);
		for (const row of rows) await ctx.db.delete("dnsProviders", row._id);
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("telemetryProviders")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) await ctx.db.delete("telemetryProviders", row._id);
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("vectorTargets")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) await ctx.db.delete("vectorTargets", row._id);
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("projectExports")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) {
			await ctx.storage.delete(row.storageId).catch(() => {});
			await ctx.db.delete("projectExports", row._id);
		}
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("organizationSettings")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) {
			await ctx.db.delete("organizationSettings", row._id);
		}
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("gitProviders")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) {
			const tokens = await ctx.db
				.query("gitProviderTokens")
				.withIndex("by_gitProviderId", (q) => q.eq("gitProviderId", row._id))
				.take(BATCH);
			for (const token of tokens) {
				await ctx.db.delete("gitProviderTokens", token._id);
			}
			if (full(tokens)) return true;
			await ctx.db.delete("gitProviders", row._id);
		}
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("registries")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) {
			const tests = await ctx.db
				.query("registryTests")
				.withIndex("by_registryId", (q) => q.eq("registryId", row._id))
				.take(BATCH);
			for (const test of tests) await ctx.db.delete("registryTests", test._id);
			if (full(tests)) return true;
			await ctx.db.delete("registries", row._id);
		}
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("sandboxes")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) {
			await cancelScheduled(ctx, row.expiryCheckId);
			await ctx.db.delete("sandboxes", row._id);
		}
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("liveSessions")
			.withIndex("by_organizationId_and_status", (q) =>
				q.eq("organizationId", org),
			)
			.take(BATCH);
		for (const row of rows) await ctx.db.delete("liveSessions", row._id);
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("serviceEvents")
			.withIndex("by_organizationId", (q) => q.eq("organizationId", org))
			.take(BATCH);
		for (const row of rows) await ctx.db.delete("serviceEvents", row._id);
		return full(rows);
	},
	async (ctx, org) => {
		const rows = await ctx.db
			.query("memberships")
			.withIndex("by_organizationId_and_userId", (q) =>
				q.eq("organizationId", org),
			)
			.take(BATCH);
		for (const row of rows) await ctx.db.delete("memberships", row._id);
		return full(rows);
	},
];

const sweep = async (
	ctx: MutationCtx,
	organizationId: string,
	step: number,
): Promise<Next> => {
	const run = sweepSteps[step];
	if (!run) return { phase: "jobs", cursor: null, attempt: 0 };
	return (await run(ctx, organizationId))
		? { phase: "sweep", step }
		: { phase: "sweep", step: step + 1 };
};

// Deletes one job's children; false while log chunks remain.
const removeJobChildren = async (ctx: MutationCtx, jobId: Id<"jobs">) => {
	const chunks = await ctx.db
		.query("jobLogChunks")
		.withIndex("by_jobId_and_seq", (q) => q.eq("jobId", jobId))
		.take(LOG_CHUNK_BATCH);
	for (const chunk of chunks) await ctx.db.delete("jobLogChunks", chunk._id);
	if (chunks.length === LOG_CHUNK_BATCH) return false;
	for (const lease of await ctx.db
		.query("jobLeases")
		.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
		.take(10)) {
		await ctx.db.delete("jobLeases", lease._id);
	}
	for (const row of await ctx.db
		.query("deployments")
		.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
		.take(10)) {
		await ctx.db.delete("deployments", row._id);
	}
	for (const row of await ctx.db
		.query("applicationOps")
		.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
		.take(10)) {
		await ctx.db.delete("applicationOps", row._id);
	}
	for (const row of await ctx.db
		.query("composeOps")
		.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
		.take(10)) {
		await ctx.db.delete("composeOps", row._id);
	}
	for (const row of await ctx.db
		.query("databaseOps")
		.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
		.take(10)) {
		await ctx.db.delete("databaseOps", row._id);
	}
	for (const row of await ctx.db
		.query("infraOps")
		.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
		.take(10)) {
		await ctx.db.delete("infraOps", row._id);
	}
	for (const row of await ctx.db
		.query("registryTests")
		.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
		.take(10)) {
		await ctx.db.delete("registryTests", row._id);
	}
	return true;
};

// Running jobs hold a lease the agent still uses; they are left for a later
// pass until the wait budget runs out.
const removeJobs = async (
	ctx: MutationCtx,
	organizationId: string,
	cursor: string | null,
	attempt: number,
): Promise<Next> => {
	const keepRunning = attempt < MAX_WAITS;
	const page = await ctx.db
		.query("jobs")
		.withIndex("by_organizationId", (q) =>
			q.eq("organizationId", organizationId),
		)
		.paginate({ cursor, numItems: JOB_PAGE });
	for (const job of page.page) {
		if (keepRunning && job.status === "running") continue;
		if (!(await removeJobChildren(ctx, job._id))) {
			return { phase: "jobs", cursor, attempt };
		}
		await ctx.db.delete("jobs", job._id);
	}
	if (!page.isDone) {
		return { phase: "jobs", cursor: page.continueCursor, attempt };
	}
	const remaining = await ctx.db
		.query("jobs")
		.withIndex("by_organizationId", (q) =>
			q.eq("organizationId", organizationId),
		)
		.first();
	// Past the wait budget even running jobs are deleted; the extra passes only
	// catch jobs enqueued meanwhile by the scheduled cascades.
	if (remaining && attempt <= MAX_WAITS + 3) {
		return { delayMs: WAIT_MS, phase: "jobs", attempt: attempt + 1 };
	}
	return { phase: "secrets" };
};

const removeSecrets = async (
	ctx: MutationCtx,
	organizationId: string,
): Promise<Next> => {
	const rows = await ctx.db
		.query("secrets")
		.withIndex("by_organizationId", (q) =>
			q.eq("organizationId", organizationId),
		)
		.take(BATCH);
	for (const row of rows) await ctx.db.delete("secrets", row._id);
	return full(rows) ? { phase: "secrets" } : null;
};

export const run = internalMutation({
	args: {
		organizationId: v.string(),
		phase: v.optional(phase),
		step: v.optional(v.number()),
		cursor: v.optional(v.union(v.string(), v.null())),
		attempt: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const { organizationId } = args;
		const attempt = args.attempt ?? 0;
		let next: Next;
		switch (args.phase ?? "projects") {
			case "projects":
				next = await removeProjects(ctx, organizationId);
				break;
			case "services":
				next = await waitForServices(ctx, organizationId, attempt);
				break;
			case "servers":
				next = await removeServers(ctx, organizationId);
				break;
			case "sweep":
				next = await sweep(ctx, organizationId, args.step ?? 0);
				break;
			case "jobs":
				next = await removeJobs(
					ctx,
					organizationId,
					args.cursor ?? null,
					attempt,
				);
				break;
			case "secrets":
				next = await removeSecrets(ctx, organizationId);
				break;
		}
		if (!next) return null;
		const { delayMs, ...state } =
			"delayMs" in next ? next : { ...next, delayMs: 0 };
		await ctx.scheduler.runAfter(delayMs, internal.organizationCascade.run, {
			organizationId,
			...state,
		});
		return null;
	},
});
