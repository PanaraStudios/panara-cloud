// A compose service's containers (by app name or stack) and the container
// actions of a compose's Containers tab, served from the
// host's `containers` snapshot (infra domain) and narrowed to this compose's
// own containers, so members never see other services on the host.
import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { mutation, type QueryCtx, query } from "../_generated/server";
import { enqueueHostJob, enqueueInspect } from "../infra/hostJobs";
import { recordServiceEvent } from "../lib/serviceEvents";
import { loadCompose, partitionOf } from "./lib";

export type ComposeContainer = {
	containerId: string;
	name: string;
	image: string;
	ports: string;
	state: string;
	status: string;
	created: number;
	service: string | null;
	composeProject: string | null;
};

const belongsTo = (compose: Doc<"compose">, container: ComposeContainer) =>
	compose.composeType === "stack"
		? (container.service ?? container.name).startsWith(`${compose.appName}_`)
		: container.composeProject === compose.appName;

const parseContainers = (data: string | undefined): ComposeContainer[] => {
	if (!data) return [];
	try {
		const parsed: unknown = JSON.parse(data);
		return Array.isArray(parsed) ? (parsed as ComposeContainer[]) : [];
	} catch {
		return [];
	}
};

const loadContainers = async (ctx: QueryCtx, compose: Doc<"compose">) => {
	const snapshot = await ctx.db
		.query("infraSnapshots")
		.withIndex("by_serverId_and_kind", (q) =>
			q.eq("serverId", compose.serverId).eq("kind", "containers"),
		)
		.unique();
	return {
		snapshot,
		containers: parseContainers(snapshot?.data).filter((container) =>
			belongsTo(compose, container),
		),
	};
};

export const list = query({
	args: { composeId: v.id("compose") },
	handler: async (ctx, { composeId }) => {
		const { compose } = await loadCompose(ctx, composeId, "service", "read");
		const { snapshot, containers } = await loadContainers(ctx, compose);
		return {
			containers,
			refreshedAt: snapshot?.refreshedAt ?? null,
			error: snapshot?.error ?? null,
		};
	},
});

// Queues a fresh `containers` snapshot of the compose's host; repeated
// requests collapse into the one already waiting.
export const refresh = mutation({
	args: { composeId: v.id("compose") },
	handler: async (ctx, { composeId }) => {
		const { compose, userId } = await loadCompose(
			ctx,
			composeId,
			"service",
			"read",
		);
		return await enqueueInspect(
			ctx,
			{
				organizationId: compose.organizationId,
				partition: partitionOf(compose),
				serverId: compose.serverId,
				userId,
			},
			"containers",
		);
	},
});

const containerAction = v.union(
	v.literal("start"),
	v.literal("stop"),
	v.literal("restart"),
	v.literal("kill"),
);

const ACTION_TYPES = {
	start: "containerStart",
	stop: "containerStop",
	restart: "containerRestart",
	kill: "containerKill",
} as const;

export const runAction = mutation({
	args: {
		composeId: v.id("compose"),
		containerId: v.string(),
		action: containerAction,
	},
	handler: async (ctx, { composeId, containerId, action }) => {
		const { compose, userId } = await loadCompose(
			ctx,
			composeId,
			"docker",
			"read",
		);
		const { containers } = await loadContainers(ctx, compose);
		if (
			!containers.some((container) => container.containerId === containerId)
		) {
			throw new ConvexError("Container not found in this compose");
		}
		await recordServiceEvent(
			ctx,
			"compose",
			compose,
			action === "restart"
				? "lifecycle.restart"
				: action === "start"
					? "lifecycle.start"
					: "lifecycle.stop",
			userId,
			{
				container: containers.find((c) => c.containerId === containerId)?.name,
			},
		);
		const partition = partitionOf(compose);
		return await enqueueHostJob(
			ctx,
			{
				organizationId: compose.organizationId,
				partition,
				userId,
			},
			`docker:${partition}`,
			{
				kind: "infra.dockerAction",
				serverId: compose.serverId,
				action: { type: ACTION_TYPES[action], containerId },
			},
		);
	},
});
