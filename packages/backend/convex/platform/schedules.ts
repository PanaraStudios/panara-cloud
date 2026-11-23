import { paginationOptsValidator } from "convex/server";
import { ConvexError, type Infer, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	internalMutation,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "../_generated/server";
import { validateComposeServiceName } from "../databases/lib";
import { getRootOrganizationId, requireInstanceAdmin } from "../infra/access";
import { requireCaller } from "../lib/access";
import { enqueueJob } from "../lib/jobs";
import {
	canAccessService,
	requirePermission,
	requireServicePermission,
} from "../lib/permissions";
import { actorOf, recordOwnerEvent } from "../lib/serviceEvents";
import { LOCAL_PARTITION } from "../tables/core";
import { scheduleTarget } from "../tables/platform";
import { nextRunAfter, parseSchedule } from "./lib/cron";
import { resolveServiceRef } from "./lib/serviceRefs";

const MAX_SCHEDULES = 200;
const MAX_RUNS = 50;
const RECENT_RUNS = 5;
const RECONCILE_BATCH = 100;
const MAX_SCRIPT_LENGTH = 256 * 1024;
const MAX_COMMAND_LENGTH = 16 * 1024;
const REMOVE_BATCH = 100;

type ScheduleTarget = Infer<typeof scheduleTarget>;
type TargetKind = ScheduleTarget["kind"];

const isHostKind = (kind: TargetKind) => kind === "server" || kind === "panel";

const targetKind = v.union(
	v.literal("application"),
	v.literal("compose"),
	v.literal("server"),
	v.literal("panel"),
);

const PANEL_ONLY_ADMIN =
	"Only the instance administrator can manage schedules on the Panara Cloud server";

// Panel schedules run as root on the host that runs Panara Cloud itself.
const requirePanelScheduleAccess = async (
	ctx: QueryCtx,
	organizationId: string,
) => {
	const { organizationId: root } = await requireInstanceAdmin(ctx).catch(() => {
		throw new ConvexError(PANEL_ONLY_ADMIN);
	});
	if (root !== organizationId) throw new ConvexError(PANEL_ONLY_ADMIN);
};

// Host-level schedules run as root on a host, so they stay with owners and
// admins even for reads.
// Service schedules follow the schedule permission on the target service.
const requireScheduleAccess = async (
	ctx: QueryCtx,
	organizationId: string,
	kind: TargetKind,
	targetId: string | undefined,
	action: "read" | "create" | "update" | "delete",
) => {
	// Deleting stays with the organization's admins so a panel schedule left
	// in another organization can still be cleaned up.
	if (kind === "panel" && action !== "delete") {
		await requirePanelScheduleAccess(ctx, organizationId);
	}
	if (isHostKind(kind)) {
		const access = await requirePermission(
			ctx,
			organizationId,
			"schedule",
			action,
		);
		if (access.role === "member") {
			throw new ConvexError(
				"Only owners and admins can manage host-level schedules",
			);
		}
		return access;
	}
	if (!targetId) throw new ConvexError("targetId is required");
	return await requireServicePermission(
		ctx,
		{ _id: targetId, organizationId },
		"schedule",
		action,
	);
};

const targetIdOf = (target: ScheduleTarget) =>
	target.kind === "application"
		? target.applicationId
		: target.kind === "compose"
			? target.composeId
			: target.kind === "server"
				? target.serverId
				: undefined;

// Returns the server (partition) the schedule runs on, after checking the
// target belongs to the organization.
const resolveTarget = async (
	ctx: QueryCtx,
	organizationId: string,
	target: ScheduleTarget,
): Promise<{ targetId: string; partition: string }> => {
	switch (target.kind) {
		case "panel":
			// Also checked when a run fires, so a panel schedule left in another
			// organization never reaches the panel host.
			if ((await getRootOrganizationId(ctx)) !== organizationId) {
				throw new ConvexError(PANEL_ONLY_ADMIN);
			}
			return { targetId: organizationId, partition: LOCAL_PARTITION };
		case "server": {
			const server = await ctx.db.get("servers", target.serverId);
			if (!server || server.organizationId !== organizationId) {
				throw new ConvexError("Server not found");
			}
			return { targetId: server._id, partition: server._id };
		}
		case "application":
		case "compose": {
			const id =
				target.kind === "application" ? target.applicationId : target.composeId;
			const ref = await resolveServiceRef(ctx, target.kind, id);
			if (!ref || ref.organizationId !== organizationId) {
				throw new ConvexError(
					target.kind === "application"
						? "Application not found"
						: "Compose not found",
				);
			}
			if (target.kind === "compose") {
				validateComposeServiceName(target.serviceName);
			}
			return { targetId: id, partition: ref.serverId ?? LOCAL_PARTITION };
		}
	}
};

const validateFields = (fields: {
	name: string;
	cronExpression: string;
	timezone?: string;
	command: string;
	script?: string;
	kind: TargetKind;
}) => {
	if (!fields.name.trim()) throw new ConvexError("Name is required");
	try {
		parseSchedule(fields.cronExpression, fields.timezone);
	} catch (error) {
		throw new ConvexError(error instanceof Error ? error.message : "Invalid");
	}
	if (fields.command.length > MAX_COMMAND_LENGTH) {
		throw new ConvexError("Command is too long");
	}
	if ((fields.script ?? "").length > MAX_SCRIPT_LENGTH) {
		throw new ConvexError("Script is too large");
	}
	if (isHostKind(fields.kind)) {
		if (!fields.script?.trim()) throw new ConvexError("Script is required");
	} else if (!fields.command.trim()) {
		throw new ConvexError("Command is required");
	}
};

const cancelPending = async (
	ctx: MutationCtx,
	scheduledFunctionId: Id<"_scheduled_functions"> | undefined,
) => {
	if (!scheduledFunctionId) return;
	const pending = await ctx.db.system
		.get("_scheduled_functions", scheduledFunctionId)
		.catch(() => null);
	if (pending?.state.kind === "pending") {
		await ctx.scheduler.cancel(scheduledFunctionId);
	}
};

// Cancels any pending run and, when enabled, schedules the next one. The
// generation bump turns any run already in flight into a no-op.
export const rescheduleSchedule = async (
	ctx: MutationCtx,
	schedule: Doc<"schedules">,
) => {
	await cancelPending(ctx, schedule.scheduledFunctionId);
	const generation = schedule.generation + 1;
	const next = schedule.enabled
		? nextRunAfter(schedule.cronExpression, schedule.timezone, Date.now())
		: null;
	const scheduledFunctionId =
		next === null
			? undefined
			: await ctx.scheduler.runAt(next, internal.platform.schedules.fire, {
					scheduleId: schedule._id,
					generation,
				});
	await ctx.db.patch("schedules", schedule._id, {
		generation,
		nextRunAt: next ?? undefined,
		scheduledFunctionId,
	});
};

const enqueueRun = async (
	ctx: MutationCtx,
	schedule: Doc<"schedules">,
	partition: string,
	requestedBy?: string,
): Promise<Id<"jobs"> | null> => {
	const group = `schedule:${schedule._id}`;
	// Don't pile up runs behind one that hasn't started (e.g. agent offline).
	const queued = await ctx.db
		.query("jobs")
		.withIndex("by_group_and_status", (q) =>
			q.eq("group", group).eq("status", "queued"),
		)
		.first();
	if (queued && !requestedBy) return null;
	const jobId = await enqueueJob(ctx, {
		organizationId: schedule.organizationId,
		partition,
		group,
		spec: { kind: "platform.scheduleRun", scheduleId: schedule._id },
		idempotent: false,
		requestedBy,
	});
	await ctx.db.insert("deployments", {
		organizationId: schedule.organizationId,
		jobId,
		target: { kind: "schedule", id: schedule._id },
		title: schedule.name,
		description: requestedBy ? "Manual run" : "Scheduled run",
	});
	return jobId;
};

const scheduleFields = {
	name: v.string(),
	description: v.optional(v.string()),
	cronExpression: v.string(),
	timezone: v.optional(v.string()),
	shellType: v.union(v.literal("bash"), v.literal("sh")),
	command: v.string(),
	script: v.optional(v.string()),
	enabled: v.boolean(),
};

export const create = mutation({
	args: {
		organizationId: v.string(),
		target: scheduleTarget,
		...scheduleFields,
	},
	handler: async (ctx, { organizationId, target, script, ...fields }) => {
		await requireScheduleAccess(
			ctx,
			organizationId,
			target.kind,
			targetIdOf(target),
			"create",
		);
		validateFields({ ...fields, script, kind: target.kind });
		const { targetId } = await resolveTarget(ctx, organizationId, target);
		const scheduleId = await ctx.db.insert("schedules", {
			organizationId,
			...fields,
			name: fields.name.trim(),
			cronExpression: fields.cronExpression.trim(),
			timezone: fields.timezone?.trim() || undefined,
			appName: `schedule-${crypto.randomUUID().slice(0, 8)}`,
			target,
			targetId,
			generation: 0,
		});
		if (script !== undefined && isHostKind(target.kind)) {
			await ctx.db.insert("scheduleScripts", {
				organizationId,
				scheduleId,
				script,
			});
		}
		const schedule = await ctx.db.get("schedules", scheduleId);
		if (schedule) await rescheduleSchedule(ctx, schedule);
		await recordOwnerEvent(
			ctx,
			{ kind: target.kind, id: targetId },
			organizationId,
			"config.schedules",
			await actorOf(ctx),
			{ name: fields.name.trim(), action: "create" },
		);
		return scheduleId;
	},
});

export const update = mutation({
	args: {
		scheduleId: v.id("schedules"),
		...scheduleFields,
		// Compose schedules only: the service the command runs in.
		serviceName: v.optional(v.string()),
	},
	handler: async (ctx, { scheduleId, script, serviceName, ...fields }) => {
		const schedule = await ctx.db.get("schedules", scheduleId);
		if (!schedule) throw new ConvexError("Schedule not found");
		const kind = schedule.target.kind;
		await requireScheduleAccess(
			ctx,
			schedule.organizationId,
			kind,
			schedule.targetId,
			"update",
		);
		const existingScript = await ctx.db
			.query("scheduleScripts")
			.withIndex("by_scheduleId", (q) => q.eq("scheduleId", scheduleId))
			.unique();
		validateFields({
			...fields,
			script: script ?? existingScript?.script,
			kind,
		});
		let target = schedule.target;
		if (serviceName !== undefined) {
			if (target.kind !== "compose") {
				throw new ConvexError("Only compose schedules have a service name");
			}
			target = { ...target, serviceName: serviceName.trim() };
			await resolveTarget(ctx, schedule.organizationId, target);
		}
		await ctx.db.patch("schedules", scheduleId, {
			...fields,
			name: fields.name.trim(),
			cronExpression: fields.cronExpression.trim(),
			timezone: fields.timezone?.trim() || undefined,
			target,
		});
		if (script !== undefined && isHostKind(kind)) {
			if (existingScript) {
				await ctx.db.patch("scheduleScripts", existingScript._id, { script });
			} else {
				await ctx.db.insert("scheduleScripts", {
					organizationId: schedule.organizationId,
					scheduleId,
					script,
				});
			}
		}
		const updated = await ctx.db.get("schedules", scheduleId);
		if (updated) await rescheduleSchedule(ctx, updated);
		await recordOwnerEvent(
			ctx,
			{ kind, id: schedule.targetId },
			schedule.organizationId,
			"config.schedules",
			await actorOf(ctx),
			{ name: fields.name.trim(), action: "update" },
		);
	},
});

export const setEnabled = mutation({
	args: { scheduleId: v.id("schedules"), enabled: v.boolean() },
	handler: async (ctx, { scheduleId, enabled }) => {
		const schedule = await ctx.db.get("schedules", scheduleId);
		if (!schedule) throw new ConvexError("Schedule not found");
		await requireScheduleAccess(
			ctx,
			schedule.organizationId,
			schedule.target.kind,
			schedule.targetId,
			"update",
		);
		await rescheduleSchedule(ctx, { ...schedule, enabled });
		await ctx.db.patch("schedules", scheduleId, { enabled });
		await recordOwnerEvent(
			ctx,
			{ kind: schedule.target.kind, id: schedule.targetId },
			schedule.organizationId,
			"config.schedules",
			await actorOf(ctx),
			{
				name: schedule.name,
				action: "update",
				fields: [enabled ? "enabled" : "disabled"],
			},
		);
	},
});

const deleteSchedule = async (ctx: MutationCtx, schedule: Doc<"schedules">) => {
	await cancelPending(ctx, schedule.scheduledFunctionId);
	const script = await ctx.db
		.query("scheduleScripts")
		.withIndex("by_scheduleId", (q) => q.eq("scheduleId", schedule._id))
		.unique();
	if (script) await ctx.db.delete("scheduleScripts", script._id);
	await ctx.db.delete("schedules", schedule._id);
};

export const remove = mutation({
	args: { scheduleId: v.id("schedules") },
	handler: async (ctx, { scheduleId }) => {
		const schedule = await ctx.db.get("schedules", scheduleId);
		if (!schedule) return;
		await requireScheduleAccess(
			ctx,
			schedule.organizationId,
			schedule.target.kind,
			schedule.targetId,
			"delete",
		);
		await deleteSchedule(ctx, schedule);
		await recordOwnerEvent(
			ctx,
			{ kind: schedule.target.kind, id: schedule.targetId },
			schedule.organizationId,
			"config.schedules",
			await actorOf(ctx),
			{ name: schedule.name, action: "remove" },
		);
	},
});

export const runNow = mutation({
	args: { scheduleId: v.id("schedules") },
	handler: async (ctx, { scheduleId }) => {
		const schedule = await ctx.db.get("schedules", scheduleId);
		if (!schedule) throw new ConvexError("Schedule not found");
		const { userId } = await requireScheduleAccess(
			ctx,
			schedule.organizationId,
			schedule.target.kind,
			schedule.targetId,
			"create",
		);
		const { partition } = await resolveTarget(
			ctx,
			schedule.organizationId,
			schedule.target,
		);
		return await enqueueRun(ctx, schedule, partition, userId);
	},
});

const recentRuns = async (
	ctx: QueryCtx,
	scheduleId: Id<"schedules">,
	limit: number,
) => {
	const deployments = await ctx.db
		.query("deployments")
		.withIndex("by_target", (q) =>
			q.eq("target.kind", "schedule").eq("target.id", scheduleId),
		)
		.order("desc")
		.take(limit);
	return await Promise.all(
		deployments.map(async (deployment) => {
			const job = await ctx.db.get("jobs", deployment.jobId);
			return {
				deploymentId: deployment._id,
				jobId: deployment.jobId,
				title: deployment.title,
				description: deployment.description,
				createdAt: deployment._creationTime,
				status: job?.status ?? "failed",
				startedAt: job?.startedAt,
				finishedAt: job?.finishedAt,
				error: job?.error,
			};
		}),
	);
};

const publicSchedule = ({
	scheduledFunctionId: _f,
	generation: _g,
	...schedule
}: Doc<"schedules">) => schedule;

// Lists the schedules of one target: an application, a compose service, a
// server, or the panel host (targetId omitted).
export const list = query({
	args: {
		organizationId: v.string(),
		kind: targetKind,
		targetId: v.optional(v.string()),
	},
	handler: async (ctx, { organizationId, kind, targetId }) => {
		const id = kind === "panel" ? organizationId : targetId;
		if (!id) throw new ConvexError("targetId is required");
		await requireScheduleAccess(ctx, organizationId, kind, id, "read");
		const schedules = await ctx.db
			.query("schedules")
			.withIndex("by_targetId", (q) => q.eq("targetId", id))
			.take(MAX_SCHEDULES);
		const visible = schedules.filter(
			(s) => s.organizationId === organizationId && s.target.kind === kind,
		);
		return await Promise.all(
			visible.map(async (schedule) => ({
				...publicSchedule(schedule),
				recentRuns: await recentRuns(ctx, schedule._id, RECENT_RUNS),
			})),
		);
	},
});

export const get = query({
	args: { scheduleId: v.id("schedules") },
	handler: async (ctx, { scheduleId }) => {
		const schedule = await ctx.db.get("schedules", scheduleId);
		if (!schedule) return null;
		await requireScheduleAccess(
			ctx,
			schedule.organizationId,
			schedule.target.kind,
			schedule.targetId,
			"read",
		);
		const script = await ctx.db
			.query("scheduleScripts")
			.withIndex("by_scheduleId", (q) => q.eq("scheduleId", scheduleId))
			.unique();
		return { ...publicSchedule(schedule), script: script?.script };
	},
});

export const runs = query({
	args: { scheduleId: v.id("schedules"), limit: v.optional(v.number()) },
	handler: async (ctx, { scheduleId, limit }) => {
		const schedule = await ctx.db.get("schedules", scheduleId);
		if (!schedule) return [];
		await requireScheduleAccess(
			ctx,
			schedule.organizationId,
			schedule.target.kind,
			schedule.targetId,
			"read",
		);
		const take = Math.min(Math.max(limit ?? MAX_RUNS, 1), MAX_RUNS);
		return await recentRuns(ctx, scheduleId, take);
	},
});

// Previews the next run times so the UI can show what a cron expression and
// timezone mean before saving.
export const previewNextRuns = query({
	args: {
		cronExpression: v.string(),
		timezone: v.optional(v.string()),
		after: v.number(),
		count: v.optional(v.number()),
	},
	handler: async (ctx, { cronExpression, timezone, after, count }) => {
		await requireCaller(ctx);
		try {
			return parseSchedule(cronExpression, timezone)
				.nextRuns(Math.min(Math.max(count ?? 5, 1), 20), new Date(after))
				.map((date) => date.getTime());
		} catch (error) {
			throw new ConvexError(error instanceof Error ? error.message : "Invalid");
		}
	},
});

export const fire = internalMutation({
	args: { scheduleId: v.id("schedules"), generation: v.number() },
	handler: async (ctx, { scheduleId, generation }) => {
		const schedule = await ctx.db.get("schedules", scheduleId);
		if (!schedule?.enabled || schedule.generation !== generation) {
			return;
		}
		let partition: string;
		try {
			({ partition } = await resolveTarget(
				ctx,
				schedule.organizationId,
				schedule.target,
			));
		} catch (error) {
			console.warn(
				`Disabling schedule ${scheduleId}: ${error instanceof Error ? error.message : error}`,
			);
			await rescheduleSchedule(ctx, { ...schedule, enabled: false });
			await ctx.db.patch("schedules", scheduleId, { enabled: false });
			return;
		}
		await enqueueRun(ctx, schedule, partition);
		await rescheduleSchedule(ctx, schedule);
	},
});

// Scheduled functions are not part of snapshot exports, so after an import
// (or any lost scheduler state) enabled schedules have no pending run. Safe to
// run repeatedly: schedules with a pending or running fire are left alone.
export const reconcileSchedules = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	handler: async (ctx, { cursor }) => {
		const page = await ctx.db
			.query("schedules")
			.withIndex("by_enabled", (q) => q.eq("enabled", true))
			.paginate({ numItems: RECONCILE_BATCH, cursor: cursor ?? null });
		let rescheduled = 0;
		for (const schedule of page.page) {
			const scheduled = schedule.scheduledFunctionId
				? await ctx.db.system
						.get("_scheduled_functions", schedule.scheduledFunctionId)
						.catch(() => null)
				: null;
			const state = scheduled?.state.kind;
			if (state === "pending" || state === "inProgress") continue;
			await rescheduleSchedule(ctx, schedule);
			rescheduled++;
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.platform.schedules.reconcileSchedules,
				{ cursor: page.continueCursor },
			);
		}
		return { rescheduled, isDone: page.isDone };
	},
});

// For other domains: call when an application, compose service or server is
// deleted (schedules are removed with their target).
export const removeForTarget = internalMutation({
	args: { targetId: v.string() },
	handler: async (ctx, { targetId }) => {
		const batch = await ctx.db
			.query("schedules")
			.withIndex("by_targetId", (q) => q.eq("targetId", targetId))
			.take(REMOVE_BATCH);
		for (const schedule of batch) await deleteSchedule(ctx, schedule);
		if (batch.length === REMOVE_BATCH) {
			await ctx.scheduler.runAfter(
				0,
				internal.platform.schedules.removeForTarget,
				{ targetId },
			);
		}
	},
});

export const listForOrganization = query({
	args: {
		organizationId: v.string(),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, { organizationId, paginationOpts }) => {
		const access = await requirePermission(
			ctx,
			organizationId,
			"schedule",
			"read",
		);
		const result = await ctx.db
			.query("schedules")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.paginate(paginationOpts);
		const panelVisible = await requirePanelScheduleAccess(
			ctx,
			organizationId,
		).then(
			() => true,
			() => false,
		);
		const visible = result.page.filter((schedule) =>
			access.scope
				? !isHostKind(schedule.target.kind) &&
					canAccessService(access, schedule.targetId)
				: schedule.target.kind !== "panel" || panelVisible,
		);
		return { ...result, page: visible.map(publicSchedule) };
	},
});
