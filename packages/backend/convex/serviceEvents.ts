import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	internalMutation,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import { startDeploy, startRedeploy, startReload } from "./applications/deploy";
import { applicationGroup } from "./applications/lib";
import { startDeploy as startComposeDeploy } from "./compose/deploy";
import { group as composeGroup } from "./compose/lib";
import { startDeploy as startDatabaseDeploy } from "./databases/databases";
import { groupFor } from "./databases/lib";
import { requireAgent } from "./lib/agentAuth";
import {
	canAccessService,
	requirePermission,
	requireServicePermission,
} from "./lib/permissions";
import { describeEvent } from "./lib/serviceEvents";
import { type HostTarget, resolveHostTarget } from "./lib/targets";
import {
	type AppliedCutoffs,
	type ServiceTarget,
	type StagedReapply,
	serviceTarget,
} from "./tables/serviceEvents";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 500;
const REDEPLOY_SCAN = 10;
const MAX_PENDING_LIST = 100;
// Lists show "N" up to the cap and "N+" beyond it.
const PENDING_COUNT_CAP = 20;
const MAX_COUNT_TARGETS = 50;
const MAX_REPORTED = 100;
// A crash loop becomes one row with a count instead of one row per restart.
const COALESCE_MS = 15 * 60 * 1000;
const MAX_WATCHED_SERVERS = 500;

type ServiceDoc = Doc<"applications"> | Doc<"compose"> | Doc<"databases">;

const loadTarget = async (
	ctx: QueryCtx,
	target: ServiceTarget,
): Promise<ServiceDoc | null> => {
	const table =
		target.kind === "application"
			? "applications"
			: target.kind === "compose"
				? "compose"
				: "databases";
	const id = ctx.db.normalizeId(table, target.id);
	return id ? await ctx.db.get(table, id) : null;
};

const requireTarget = async (ctx: QueryCtx, target: ServiceTarget) => {
	const service = await loadTarget(ctx, target);
	if (!service) throw new ConvexError("Service not found");
	await requireServicePermission(ctx, service, "service", "read");
	return service;
};

// Newest first.
export const list = query({
	args: { target: serviceTarget, paginationOpts: paginationOptsValidator },
	handler: async (ctx, { target, paginationOpts }) => {
		await requireTarget(ctx, target);
		return await ctx.db
			.query("serviceEvents")
			.withIndex("by_target", (q) =>
				q.eq("target.kind", target.kind).eq("target.id", target.id),
			)
			.order("desc")
			.paginate(paginationOpts);
	},
});

// Organization-wide feed. Members' pages leave out services they can't
// reach, so a page may hold fewer than `numItems` rows.
export const listForOrganization = query({
	args: { organizationId: v.string(), paginationOpts: paginationOptsValidator },
	handler: async (ctx, { organizationId, paginationOpts }) => {
		const access = await requirePermission(
			ctx,
			organizationId,
			"service",
			"read",
		);
		const result = await ctx.db
			.query("serviceEvents")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.order("desc")
			.paginate(paginationOpts);
		return {
			...result,
			page: result.page.filter((event) =>
				canAccessService(access, event.target.id),
			),
		};
	},
});

type JobSpec = Doc<"jobs">["spec"];
type Applies = "deploy" | StagedReapply;

const DEPLOY_KINDS = {
	application: ["application.deploy", "application.redeploy"],
	compose: ["compose.deploy", "compose.redeploy"],
	database: ["databases.deploy", "databases.rebuild"],
} as const satisfies Record<ServiceTarget["kind"], JobSpec["kind"][]>;

// What a successful job applies of the settings it read when it started.
// Rollbacks restore an older snapshot instead (see `rollbackCutoffs`).
// Previews, transfers, backups and database reloads (which scale the
// service down and up without touching the spec) apply nothing.
const appliedBy = (spec: JobSpec): Applies | null => {
	switch (spec.kind) {
		case "application.deploy":
		case "compose.deploy":
		case "databases.deploy":
		case "databases.rebuild":
			return "deploy";
		case "application.redeploy":
			return spec.rebuild ? "build" : "spec";
		case "compose.redeploy":
			return "build";
		case "application.reload":
			return "spec";
		default:
			return null;
	}
};

const TIERS: Record<ServiceTarget["kind"], readonly Applies[]> = {
	application: ["deploy", "build", "spec"],
	compose: ["deploy", "build"],
	database: ["deploy"],
};

export type PendingAction = "reload" | "rebuild" | "deploy";

// The lightest action each tier offers. Compose and databases only offer a
// deploy: a compose redeploy also applies "build" changes and still counts
// as applying them, but a deploy is the one action that ships them all, and
// a database rebuild wipes its volumes.
const ACTIONS: Record<ServiceTarget["kind"], Record<Applies, PendingAction>> = {
	application: { deploy: "deploy", build: "rebuild", spec: "reload" },
	compose: { deploy: "deploy", build: "deploy", spec: "deploy" },
	database: { deploy: "deploy", build: "deploy", spec: "deploy" },
};

const ACTION_ORDER: readonly PendingAction[] = ["reload", "rebuild", "deploy"];

const jobGroup = (target: ServiceTarget, service: ServiceDoc) =>
	target.kind === "application"
		? applicationGroup(target.id)
		: target.kind === "compose"
			? composeGroup(service._id as Id<"compose">)
			: groupFor((service as Doc<"databases">).engine, target.id);

const NONE_APPLIED: AppliedCutoffs = { deploy: null, build: null, spec: null };

// A successful job: what it applied, or the cutoffs a rollback restored.
type Applied =
	| { at: number; applies: Applies }
	| { at: number; restores: AppliedCutoffs };

// Replays successful jobs in start order. A rollback puts back the cutoffs
// of the version it restores, so changes recorded since then are pending
// again; a lighter job only moves its own tier and those below it.
const replay = (applied: Applied[]) => {
	let cutoffs = NONE_APPLIED;
	let rolledBackAt: number | null = null;
	for (const job of [...applied].sort((a, b) => a.at - b.at)) {
		if ("restores" in job) {
			cutoffs = job.restores;
			rolledBackAt = job.at;
		} else if (job.applies === "deploy") {
			cutoffs = { deploy: job.at, build: job.at, spec: job.at };
			rolledBackAt = null;
		} else if (job.applies === "build") {
			cutoffs = { ...cutoffs, build: job.at, spec: job.at };
		} else {
			cutoffs = { ...cutoffs, spec: job.at };
		}
	}
	return { cutoffs, rolledBackAt };
};

// The cutoffs a rollback to `row` restores. Versions stored before
// `appliedAt` existed fall back to their deploy's start (as if it were a
// full deploy); null when that is gone too, and the rollback is ignored.
export const rollbackCutoffs = async (
	ctx: QueryCtx,
	row: Doc<"applicationRollbacks"> | null,
): Promise<AppliedCutoffs | null> => {
	if (!row) return null;
	if (row.appliedAt) return row.appliedAt;
	const deployment = row.deploymentId
		? await ctx.db.get("deployments", row.deploymentId)
		: null;
	const job = deployment ? await ctx.db.get("jobs", deployment.jobId) : null;
	const at = job?.startedAt;
	return at === undefined ? null : { deploy: at, build: at, spec: at };
};

const successfulJobs = async (
	ctx: QueryCtx,
	target: ServiceTarget,
	service: ServiceDoc,
) => {
	const group = jobGroup(target, service);
	const kinds: JobSpec["kind"][] = [...DEPLOY_KINDS[target.kind]];
	if (target.kind === "application") {
		kinds.push("application.reload", "application.rollback");
	}
	const applied: Applied[] = [];
	let deploying = false;
	let deployed = false;
	// Only the latest job of each kind can still set a tier's cutoff.
	for (const kind of kinds) {
		const succeeded = await ctx.db
			.query("jobs")
			.withIndex("by_group_and_kind_and_status", (q) =>
				q.eq("group", group).eq("spec.kind", kind).eq("status", "succeeded"),
			)
			.order("desc")
			// Redeploys alternate between rebuilds and image-only runs.
			.take(kind === "application.redeploy" ? REDEPLOY_SCAN : 1);
		for (const job of succeeded) {
			if (job.startedAt === undefined) continue;
			if (job.spec.kind === "application.rollback") {
				const restores =
					job.spec.appliedAt ??
					(await rollbackCutoffs(
						ctx,
						await ctx.db.get("applicationRollbacks", job.spec.rollbackId),
					));
				if (restores) applied.push({ at: job.startedAt, restores });
				continue;
			}
			const applies = appliedBy(job.spec);
			if (!applies) continue;
			applied.push({ at: job.startedAt, applies });
			if (applies === "deploy") deployed = true;
		}
		if (kind === "application.reload" || kind === "application.rollback") {
			continue;
		}
		for (const status of ["queued", "running"] as const) {
			const active = await ctx.db
				.query("jobs")
				.withIndex("by_group_and_kind_and_status", (q) =>
					q.eq("group", group).eq("spec.kind", kind).eq("status", status),
				)
				.first();
			if (active) deploying = true;
		}
	}
	return { applied, deploying, deployed };
};

type ApplyState = {
	// "deploying" while a deploy or redeploy is queued or running; its
	// changes stay pending until it succeeds.
	deployState: "never" | "deploying" | "deployed";
	// The agent reads the settings right after it claims a job, so edits
	// after a job's start aren't in it.
	appliedAt: AppliedCutoffs;
	// Start of the latest successful rollback no deploy has superseded.
	rolledBackAt: number | null;
};

const applyState = async (
	ctx: QueryCtx,
	target: ServiceTarget,
	service: ServiceDoc,
): Promise<ApplyState> => {
	const { applied, deploying, deployed } = await successfulJobs(
		ctx,
		target,
		service,
	);
	const { cutoffs, rolledBackAt } = replay(applied);
	return {
		deployState: deploying ? "deploying" : deployed ? "deployed" : "never",
		appliedAt: cutoffs,
		rolledBackAt,
	};
};

// What a rollback to the snapshot `job` (a running application deploy or
// redeploy) takes restores: the cutoffs once that job succeeds. The agent
// stores the snapshot as the job ends, so edits made while it ran may be in
// it yet count as pending after a rollback; that errs towards showing them.
export const cutoffsAfter = async (
	ctx: QueryCtx,
	service: Doc<"applications">,
	job: Doc<"jobs">,
): Promise<AppliedCutoffs> => {
	const target: ServiceTarget = { kind: "application", id: service._id };
	const { applied } = await successfulJobs(ctx, target, service);
	const applies = appliedBy(job.spec);
	if (applies && job.startedAt !== undefined) {
		applied.push({ at: job.startedAt, applies });
	}
	return replay(applied).cutoffs;
};

const actionOf = (
	kind: ServiceTarget["kind"],
	state: ApplyState,
	tier: Applies,
): PendingAction =>
	// Nothing to reload or rebuild before the first deploy.
	state.appliedAt.deploy === null ? "deploy" : ACTIONS[kind][tier];

// Staged events no successful job has applied yet, newest first: one
// indexed range per weight, each starting after the cutoff of that weight.
// `actions` counts each range (up to `limit`) under its lightest action.
const stagedEvents = async (
	ctx: QueryCtx,
	target: ServiceTarget,
	state: ApplyState,
	limit: number,
) => {
	const tiers = TIERS[target.kind];
	const ranges = await Promise.all(
		tiers.map((tier) => {
			const since = state.appliedAt[tier];
			return ctx.db
				.query("serviceEvents")
				.withIndex("by_target_and_staging", (q) => {
					const scoped = q
						.eq("target.kind", target.kind)
						.eq("target.id", target.id)
						.eq("appliesOnDeploy", true)
						.eq("reapply", tier === "deploy" ? undefined : tier);
					return since === null ? scoped : scoped.gt("_creationTime", since);
				})
				.order("desc")
				.take(limit);
		}),
	);
	const actions: Record<PendingAction, number> = {
		reload: 0,
		rebuild: 0,
		deploy: 0,
	};
	tiers.forEach((tier, i) => {
		actions[actionOf(target.kind, state, tier)] += ranges[i]?.length ?? 0;
	});
	const primaryAction =
		ACTION_ORDER.findLast((action) => actions[action] > 0) ?? null;
	const events = ranges
		.flat()
		.sort((a, b) => b._creationTime - a._creationTime)
		.slice(0, limit)
		.map((event) => ({
			...event,
			action: actionOf(target.kind, state, event.reapply ?? "deploy"),
		}));
	return { events, actions, primaryAction };
};

const capCounts = (actions: Record<PendingAction, number>, cap: number) => ({
	reload: Math.min(actions.reload, cap),
	rebuild: Math.min(actions.rebuild, cap),
	deploy: Math.min(actions.deploy, cap),
});

// "Changed since last deploy": config changes that take effect on the next
// deploy (see `appliesOnDeploy` and `reapplyOf` in lib/serviceEvents.ts)
// that no successful deploy, rebuild or reload has applied (or that a
// rollback undid), newest first. Each event carries the lightest `action`
// that applies it; `primaryAction` is the heaviest of those, the one action
// that ships every pending change (null when nothing is pending).
export const pendingChanges = query({
	args: { target: serviceTarget },
	handler: async (ctx, { target }) => {
		const service = await requireTarget(ctx, target);
		const state = await applyState(ctx, target, service);
		const { events, actions, primaryAction } = await stagedEvents(
			ctx,
			target,
			state,
			MAX_PENDING_LIST + 1,
		);
		return {
			deployState: state.deployState,
			since: state.appliedAt.deploy,
			reloadedSince:
				target.kind === "application" ? state.appliedAt.spec : null,
			rolledBackAt: state.rolledBackAt,
			count: Math.min(events.length, MAX_PENDING_LIST),
			hasMore: events.length > MAX_PENDING_LIST,
			primaryAction,
			actionCounts: capCounts(actions, MAX_PENDING_LIST),
			events: events.slice(0, MAX_PENDING_LIST),
		};
	},
});

// Pending change counts for a list of services in one organization, aligned
// with `targets`; null where the service is gone or not visible.
export const pendingChangeCounts = query({
	args: { organizationId: v.string(), targets: v.array(serviceTarget) },
	handler: async (ctx, { organizationId, targets }) => {
		if (targets.length > MAX_COUNT_TARGETS) {
			throw new ConvexError(`At most ${MAX_COUNT_TARGETS} services at once`);
		}
		const access = await requirePermission(
			ctx,
			organizationId,
			"service",
			"read",
		);
		const counts: ({
			pendingChangeCount: number;
			hasMore: boolean;
			primaryAction: PendingAction | null;
		} | null)[] = [];
		for (const target of targets) {
			const service = await loadTarget(ctx, target);
			if (
				!service ||
				service.organizationId !== organizationId ||
				!canAccessService(access, service._id)
			) {
				counts.push(null);
				continue;
			}
			const state = await applyState(ctx, target, service);
			const { events, primaryAction } = await stagedEvents(
				ctx,
				target,
				state,
				PENDING_COUNT_CAP + 1,
			);
			counts.push({
				pendingChangeCount: Math.min(events.length, PENDING_COUNT_CAP),
				hasMore: events.length > PENDING_COUNT_CAP,
				primaryAction,
			});
		}
		return counts;
	},
});

const startAction = async (
	ctx: MutationCtx,
	target: ServiceTarget,
	service: ServiceDoc,
	action: PendingAction,
): Promise<Id<"jobs">> => {
	if (target.kind === "application") {
		const applicationId = service._id as Id<"applications">;
		if (action === "reload") return await startReload(ctx, { applicationId });
		if (action === "rebuild") {
			return (await startRedeploy(ctx, { applicationId, rebuild: true })).jobId;
		}
		return (await startDeploy(ctx, { applicationId })).jobId;
	}
	if (target.kind === "compose") {
		return (
			await startComposeDeploy(ctx, { composeId: service._id as Id<"compose"> })
		).jobId;
	}
	return await startDatabaseDeploy(ctx, {
		databaseId: service._id as Id<"databases">,
	});
};

// Starts the `primaryAction` of `pendingChanges`, worked out again here so a
// stale page can't pick a lighter one. It calls the same handlers as the
// deploy, rebuild and reload mutations, so permissions, checks and job
// creation stay theirs. Null when nothing is pending.
export const applyPending = mutation({
	args: { target: serviceTarget },
	handler: async (
		ctx,
		{ target },
	): Promise<{ action: PendingAction; jobId: Id<"jobs"> } | null> => {
		const service = await requireTarget(ctx, target);
		const state = await applyState(ctx, target, service);
		const { primaryAction } = await stagedEvents(ctx, target, state, 1);
		if (!primaryAction) return null;
		return {
			action: primaryAction,
			jobId: await startAction(ctx, target, service, primaryAction),
		};
	},
});

// Hosts whose Docker events the agent follows: the panel host and every
// active deploy server with an SSH key. Like lease-guarded targets, this
// hands the agent decrypted SSH keys, so only enrolled agents may call it.
export const watchTargets = query({
	args: {},
	handler: async (
		ctx,
	): Promise<{ serverId: string | null; target: HostTarget }[]> => {
		await requireAgent(ctx);
		const servers = await ctx.db.query("servers").take(MAX_WATCHED_SERVERS);
		const targets: { serverId: string | null; target: HostTarget }[] = [
			{ serverId: null, target: { type: "local" } },
		];
		for (const server of servers) {
			if (
				server.serverType !== "deploy" ||
				server.serverStatus === "inactive" ||
				!server.sshKeyId
			) {
				continue;
			}
			try {
				targets.push({
					serverId: server._id,
					target: await resolveHostTarget(ctx, server._id),
				});
			} catch {
				// A server whose key is missing simply isn't watched.
			}
		}
		return targets;
	},
});

const runtimeType = v.union(
	v.literal("runtime.crashed"),
	v.literal("runtime.oomKilled"),
	v.literal("runtime.unhealthy"),
);

export const reportRuntime = mutation({
	args: {
		serverId: v.optional(v.id("servers")),
		events: v.array(
			v.object({
				target: serviceTarget,
				type: runtimeType,
				exitCode: v.optional(v.number()),
				container: v.optional(v.string()),
				at: v.number(),
				count: v.number(),
			}),
		),
	},
	handler: async (ctx, { serverId, events }) => {
		await requireAgent(ctx);
		if (events.length > MAX_REPORTED) {
			throw new ConvexError(`At most ${MAX_REPORTED} events per call`);
		}
		let recorded = 0;
		for (const event of events) {
			const service = await loadTarget(ctx, event.target);
			// Containers left behind on a server the service moved away from
			// don't belong to it any more.
			if (!service || service.serverId !== serverId) continue;
			const count = Math.max(1, Math.floor(event.count));
			const at = Math.min(event.at, Date.now());
			const container = event.container?.slice(0, 200);
			const recent = await ctx.db
				.query("serviceEvents")
				.withIndex("by_target", (q) =>
					q
						.eq("target.kind", event.target.kind)
						.eq("target.id", event.target.id)
						.gt("_creationTime", at - COALESCE_MS),
				)
				.order("desc")
				.take(10);
			const same = recent.find((row) => row.type === event.type);
			if (same) {
				const details = {
					...same.details,
					exitCode: event.exitCode ?? same.details?.exitCode,
					container: container ?? same.details?.container,
					count: (same.details?.count ?? 1) + count,
					lastAt: Math.max(at, same.details?.lastAt ?? 0),
				};
				await ctx.db.patch("serviceEvents", same._id, {
					details,
					summary: describeEvent(event.type, details),
				});
			} else {
				const details = {
					exitCode: event.exitCode,
					container,
					count,
					lastAt: at,
				};
				await ctx.db.insert("serviceEvents", {
					organizationId: service.organizationId,
					target: event.target,
					type: event.type,
					summary: describeEvent(event.type, details),
					details,
					appliesOnDeploy: false,
				});
			}
			recorded++;
		}
		return recorded;
	},
});

export const prune = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - RETENTION_MS;
		const old = await ctx.db
			.query("serviceEvents")
			.withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
			.take(PRUNE_BATCH);
		for (const event of old) await ctx.db.delete("serviceEvents", event._id);
		if (old.length === PRUNE_BATCH) {
			await ctx.scheduler.runAfter(0, internal.serviceEvents.prune, {});
		}
		return old.length;
	},
});
