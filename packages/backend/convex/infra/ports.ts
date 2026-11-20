import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { type MutationCtx, mutation, query } from "../_generated/server";
import { actorOf, recordOwnerEvent } from "../lib/serviceEvents";
import { assertPublishedPortAllowed } from "../lib/swarmPolicy";
import { portProtocol, routingOwner } from "../tables/infra";
import {
	MAX_PORTS_PER_OWNER,
	requireOwnedRowPermission,
	requireRoutingPermission,
} from "./routing";
import { validatePort } from "./validation";

// Published ports are part of the swarm service spec, so they take effect on
// the owner's next deploy; nothing is queued here.
const portFields = {
	publishedPort: v.number(),
	targetPort: v.number(),
	protocol: portProtocol,
	publishMode: v.union(v.literal("ingress"), v.literal("host")),
};

const assertPortFree = async (
	ctx: MutationCtx,
	serverId: Id<"servers"> | undefined,
	publishedPort: number,
	protocol: "tcp" | "udp",
	self?: Id<"ports">,
) => {
	const clashes = await ctx.db
		.query("ports")
		.withIndex("by_serverId_and_publishedPort", (q) =>
			q.eq("serverId", serverId).eq("publishedPort", publishedPort),
		)
		.take(10);
	if (clashes.some((p) => p.protocol === protocol && p._id !== self)) {
		throw new ConvexError(
			`Port ${publishedPort}/${protocol} is already published on this server`,
		);
	}
};

export const listByOwner = query({
	args: { owner: routingOwner },
	handler: async (ctx, { owner }) => {
		await requireRoutingPermission(ctx, owner, "service", "read");
		return await ctx.db
			.query("ports")
			.withIndex("by_owner", (q) =>
				q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
			)
			.take(MAX_PORTS_PER_OWNER);
	},
});

export const create = mutation({
	args: { owner: routingOwner, ...portFields },
	handler: async (ctx, { owner, ...fields }) => {
		if (owner.kind !== "application") {
			throw new ConvexError("Ports are only supported for applications");
		}
		const { row, userId } = await requireRoutingPermission(
			ctx,
			owner,
			"service",
			"create",
		);
		validatePort(fields.publishedPort, "Published port");
		validatePort(fields.targetPort, "Target port");
		assertPublishedPortAllowed(fields.publishedPort, row.serverId);
		const existing = await ctx.db
			.query("ports")
			.withIndex("by_owner", (q) =>
				q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
			)
			.take(MAX_PORTS_PER_OWNER);
		if (existing.length >= MAX_PORTS_PER_OWNER) {
			throw new ConvexError("Too many ports");
		}
		await assertPortFree(
			ctx,
			row.serverId,
			fields.publishedPort,
			fields.protocol,
		);
		await recordOwnerEvent(
			ctx,
			owner,
			row.organizationId,
			"config.ports",
			userId,
			{ port: fields.publishedPort, action: "create" },
		);
		return await ctx.db.insert("ports", {
			organizationId: row.organizationId,
			owner,
			serverId: row.serverId,
			...fields,
		});
	},
});

export const update = mutation({
	args: { portId: v.id("ports"), ...portFields },
	handler: async (ctx, { portId, ...fields }) => {
		const port = await ctx.db.get("ports", portId);
		if (!port) throw new ConvexError("Port not found");
		await requireOwnedRowPermission(ctx, port, "service", "create");
		validatePort(fields.publishedPort, "Published port");
		validatePort(fields.targetPort, "Target port");
		assertPublishedPortAllowed(fields.publishedPort, port.serverId);
		await assertPortFree(
			ctx,
			port.serverId,
			fields.publishedPort,
			fields.protocol,
			portId,
		);
		await ctx.db.patch("ports", portId, fields);
		await recordOwnerEvent(
			ctx,
			port.owner,
			port.organizationId,
			"config.ports",
			await actorOf(ctx),
			{ port: fields.publishedPort, action: "update" },
		);
	},
});

export const remove = mutation({
	args: { portId: v.id("ports") },
	handler: async (ctx, { portId }) => {
		const port = await ctx.db.get("ports", portId);
		if (!port) return;
		await requireOwnedRowPermission(ctx, port, "service", "delete");
		await ctx.db.delete("ports", portId);
		await recordOwnerEvent(
			ctx,
			port.owner,
			port.organizationId,
			"config.ports",
			await actorOf(ctx),
			{ port: port.publishedPort, action: "remove" },
		);
	},
});
