import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	internalMutation,
	type MutationCtx,
	mutation,
} from "../_generated/server";
import { requireMember } from "../lib/access";
import { enqueueJob } from "../lib/jobs";
import { LOCAL_PARTITION } from "../tables/core";
import { getRootOrganizationId } from "./access";
import { CERTIFICATE_KEY_SECRET } from "./certificates";
import { loadWebServerSettings, TRAEFIK_ENV_SECRET } from "./webServer";

const SERVER_BATCH = 100;
const OP_TTL_MS = 60 * 60 * 1000;
const OP_BATCH = 200;
const QUEUE_SCAN = 1000;

const cleanupKey = (partition: string, now: number) =>
	`infra.cleanup:${partition}:${new Date(now).toISOString().slice(0, 10)}`;

// Walks every server in batches; the idempotency key makes a re-run on the
// same day a no-op.
export const enqueueScheduledCleanups = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	handler: async (ctx, { cursor }) => {
		const now = Date.now();
		if (!cursor) {
			const settings = await loadWebServerSettings(ctx);
			const rootOrg = await getRootOrganizationId(ctx);
			if (settings?.enableDockerCleanup && rootOrg) {
				await enqueueJob(ctx, {
					organizationId: rootOrg,
					partition: LOCAL_PARTITION,
					group: `cleanup:${LOCAL_PARTITION}`,
					spec: { kind: "infra.dockerCleanup", scope: "all" },
					idempotent: true,
					idempotencyKey: cleanupKey(LOCAL_PARTITION, now),
				});
			}
		}
		const page = await ctx.db
			.query("servers")
			.paginate({ numItems: SERVER_BATCH, cursor: cursor ?? null });
		for (const server of page.page) {
			if (
				!server.enableDockerCleanup ||
				!server.sshKeyId ||
				server.serverStatus === "inactive"
			) {
				continue;
			}
			await enqueueJob(ctx, {
				organizationId: server.organizationId,
				partition: server._id,
				group: `cleanup:${server._id}`,
				spec: {
					kind: "infra.dockerCleanup",
					serverId: server._id,
					scope: "all",
				},
				idempotent: true,
				idempotencyKey: cleanupKey(server._id, now),
			});
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.infra.cleanup.enqueueScheduledCleanups,
				{ cursor: page.continueCursor },
			);
		}
	},
});

export const expireOps = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - OP_TTL_MS;
		const stale = await ctx.db
			.query("infraOps")
			.withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
			.take(OP_BATCH);
		for (const op of stale) await ctx.db.delete("infraOps", op._id);
		if (stale.length === OP_BATCH) {
			await ctx.scheduler.runAfter(0, internal.infra.cleanup.expireOps, {});
		}
	},
});

const CASCADE_BATCH = 100;

// Deletes infra state tied to a server. Call `onServerRemoved` from the
// server delete mutation; domains and ports follow their owners instead.
export const onServerRemoved = (
	ctx: MutationCtx,
	server: { _id: Id<"servers">; organizationId: string },
) =>
	ctx.scheduler.runAfter(0, internal.infra.cleanup.cascadeServer, {
		serverId: server._id,
		organizationId: server.organizationId,
	});

export const cascadeServer = internalMutation({
	args: { serverId: v.id("servers"), organizationId: v.string() },
	handler: async (ctx, { serverId, organizationId }) => {
		let deleted = 0;
		const snapshots = await ctx.db
			.query("infraSnapshots")
			.withIndex("by_serverId_and_kind", (q) => q.eq("serverId", serverId))
			.take(CASCADE_BATCH);
		for (const row of snapshots) {
			await ctx.db.delete("infraSnapshots", row._id);
			deleted++;
		}
		const traefik = await ctx.db
			.query("traefikSettings")
			.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
			.unique();
		if (traefik) {
			await deleteSecret(ctx, TRAEFIK_ENV_SECRET, traefik._id);
			await ctx.db.delete("traefikSettings", traefik._id);
		}
		const script = await ctx.db
			.query("serverSetupScripts")
			.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
			.unique();
		if (script) await ctx.db.delete("serverSetupScripts", script._id);
		const networks = await ctx.db
			.query("networks")
			.withIndex("by_serverId_and_name", (q) => q.eq("serverId", serverId))
			.take(CASCADE_BATCH);
		for (const row of networks) {
			await ctx.db.delete("networks", row._id);
			deleted++;
		}
		const certificates = await ctx.db
			.query("certificates")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(500);
		for (const certificate of certificates) {
			if (certificate.serverId !== serverId) continue;
			await deleteCertificateRows(ctx, certificate._id);
			deleted++;
		}
		if (deleted >= CASCADE_BATCH) {
			await ctx.scheduler.runAfter(0, internal.infra.cleanup.cascadeServer, {
				serverId,
				organizationId,
			});
		}
	},
});

const deleteSecret = async (
	ctx: MutationCtx,
	kind: string,
	ownerId: string,
) => {
	const secret = await ctx.db
		.query("secrets")
		.withIndex("by_kind_and_ownerId", (q) =>
			q.eq("kind", kind).eq("ownerId", ownerId),
		)
		.unique();
	if (secret) await ctx.db.delete("secrets", secret._id);
};

const deleteCertificateRows = async (
	ctx: MutationCtx,
	certificateId: Id<"certificates">,
) => {
	const chain = await ctx.db
		.query("certificateChains")
		.withIndex("by_certificateId", (q) => q.eq("certificateId", certificateId))
		.unique();
	if (chain) await ctx.db.delete("certificateChains", chain._id);
	await deleteSecret(ctx, CERTIFICATE_KEY_SECRET, certificateId);
	await ctx.db.delete("certificates", certificateId);
};

// "Clean all deployment queue": cancels the organization's builds
// and deploys that are still waiting for a slot. Running jobs are untouched.
export const cancelQueuedDeployments = mutation({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requireMember(ctx, organizationId, "admin");
		const queued = await ctx.db
			.query("jobs")
			.withIndex("by_status", (q) => q.eq("status", "queued"))
			.take(QUEUE_SCAN);
		const now = Date.now();
		let cancelled = 0;
		for (const job of queued) {
			if (job.organizationId !== organizationId || !job.usesBuildSlot) {
				continue;
			}
			await ctx.db.patch("jobs", job._id, {
				status: "cancelled",
				cancelRequested: true,
				finishedAt: now,
			});
			cancelled++;
		}
		return cancelled;
	},
});
