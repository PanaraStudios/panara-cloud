import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { mutation, type QueryCtx, query } from "../_generated/server";
import { requireLease } from "../lib/lease";
import { requireServicePermission } from "../lib/permissions";
import { partitionOf } from "./access";
import { enqueueOp } from "./hostJobs";

// Where a file mount's service lives: its app name, the server it runs on
// and the host directory its files are written under.
const ownerRow = async (
	ctx: QueryCtx,
	{ kind, id }: Doc<"mounts">["owner"],
) => {
	if (kind === "application") {
		const appId = ctx.db.normalizeId("applications", id);
		return appId ? await ctx.db.get("applications", appId) : null;
	}
	if (kind === "compose") {
		const composeId = ctx.db.normalizeId("compose", id);
		return composeId ? await ctx.db.get("compose", composeId) : null;
	}
	if (kind === "database") {
		const databaseId = ctx.db.normalizeId("databases", id);
		return databaseId ? await ctx.db.get("databases", databaseId) : null;
	}
	return null;
};

const resolveMountHost = async (ctx: QueryCtx, mount: Doc<"mounts">) => {
	const row = await ownerRow(ctx, mount.owner);
	if (!row || row.organizationId !== mount.organizationId) return null;
	return {
		appName: row.appName,
		serverId: row.serverId,
		base:
			mount.owner.kind === "compose"
				? ("compose" as const)
				: ("applications" as const),
	};
};

// The file mount as deployed on the host,
// read by an agent job so the editor can show whether it drifted from the
// saved content. The result lands in `api.infra.snapshots.opResult` as
// `{ found, content? }`.
export const readFileOnHost = mutation({
	args: { mountId: v.id("mounts") },
	handler: async (ctx, { mountId }) => {
		const mount = await ctx.db.get("mounts", mountId);
		if (!mount) throw new ConvexError("Mount not found");
		const { userId } = await requireServicePermission(
			ctx,
			{ _id: mount.owner.id, organizationId: mount.organizationId },
			"volume",
			"read",
		);
		if (mount.type !== "file") {
			throw new ConvexError("Only file mounts have content");
		}
		const target = await resolveMountHost(ctx, mount);
		if (!target) throw new ConvexError("Mount not found");
		return await enqueueOp(
			ctx,
			{
				organizationId: mount.organizationId,
				partition: partitionOf(target.serverId),
				userId,
			},
			`mountFile:${mountId}`,
			{ kind: "infra.readMountFile", mountId },
			{ restricted: false, idempotent: true },
		);
	},
});

export const getMountFileContext = query({
	args: { jobId: v.id("jobs"), leaseId: v.string() },
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		if (job.spec.kind !== "infra.readMountFile") {
			throw new ConvexError("Not a mount file job");
		}
		const mount = await ctx.db.get("mounts", job.spec.mountId);
		if (mount?.type !== "file" || mount.organizationId !== job.organizationId) {
			return null;
		}
		const target = await resolveMountHost(ctx, mount);
		if (!target) return null;
		return {
			base: target.base,
			appName: target.appName,
			filePath: mount.filePath,
		};
	},
});
