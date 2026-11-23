import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import { requireMember } from "../lib/access";
import { LOCAL_PARTITION } from "../tables/core";
import { panelAction } from "../tables/infra";
import { getRootOrganizationId, requireInstanceAdmin } from "./access";
import { enqueueHostJob, enqueueOp } from "./hostJobs";
import { loadWebServerSettings } from "./webServer";

const PANEL_GROUP = `panel:${LOCAL_PARTITION}`;
const PUBLIC_IP_GROUP = `publicIp:${LOCAL_PARTITION}`;

// Closing the panel's direct port is only allowed from the panel domain, so
// the admin doesn't lock themselves out. The direct port is 3000 unless the
// installer was given another, which the backend isn't told: a request on any
// port but the web's own two counts as direct.
export const isPanelHostRequest = (
	currentHost: string | undefined,
	panelHost: string | undefined,
) => {
	if (!currentHost || !panelHost) return false;
	try {
		const { hostname, port } = new URL(`http://${currentHost}`);
		if (port && port !== "80" && port !== "443") return false;
		return hostname === panelHost.trim().toLowerCase();
	} catch {
		return false;
	}
};

// Reload, version check, self-update and the direct-port toggle of the panel
// itself. The agent runs them against the services named in its
// PANARA_CLOUD_IMAGES; results land in infraOps (snapshots.opResult).
export const runAction = mutation({
	args: { action: panelAction, currentHost: v.optional(v.string()) },
	handler: async (ctx, { action, currentHost }) => {
		const { userId, organizationId } = await requireInstanceAdmin(ctx);
		if (action.type === "setPanelPort" && !action.enabled) {
			const settings = await loadWebServerSettings(ctx);
			if (!settings?.host) {
				throw new ConvexError(
					"Configure a domain for the Panara Cloud panel before closing its direct port",
				);
			}
			if (!isPanelHostRequest(currentHost, settings.host)) {
				throw new ConvexError(
					`Access the panel through ${settings.host} to close its direct port`,
				);
			}
		}
		return await enqueueOp(
			ctx,
			{ organizationId, partition: LOCAL_PARTITION, userId },
			PANEL_GROUP,
			{ kind: "infra.panelAction", action },
			{ restricted: true, idempotent: action.type === "checkUpdate" },
		);
	},
});

const UPDATE_SCAN = 50;

// The newest "Update panel" job: lets the Updates dialog show an update that
// is running, or the reason the last one failed, after a page reload too.
// The other panel actions (update checks above all) share the group, so each
// status is scanned a little way back for it. null for everyone but the
// instance administrator, and before the first update.
export const lastUpdate = query({
	args: {},
	handler: async (ctx) => {
		try {
			await requireInstanceAdmin(ctx);
		} catch {
			return null;
		}
		let newest: Doc<"jobs"> | null = null;
		for (const status of [
			"queued",
			"running",
			"succeeded",
			"failed",
			"cancelled",
		] as const) {
			const jobs = await ctx.db
				.query("jobs")
				.withIndex("by_group_and_kind_and_status", (q) =>
					q
						.eq("group", PANEL_GROUP)
						.eq("spec.kind", "infra.panelAction")
						.eq("status", status),
				)
				.order("desc")
				.take(UPDATE_SCAN);
			const update = jobs.find(
				(job) =>
					job.spec.kind === "infra.panelAction" &&
					job.spec.action.type === "update",
			);
			if (update && (!newest || update._creationTime > newest._creationTime)) {
				newest = update;
			}
		}
		if (!newest) return null;
		return {
			jobId: newest._id,
			status: newest.status,
			error: newest.error ?? null,
			requestedAt: newest._creationTime,
			finishedAt: newest.finishedAt ?? null,
		};
	},
});

const PUBLIC_IP_REFRESH_MS = 60 * 60 * 1000;

// Public IP lookup: the agent looks up the panel host's public address and
// stores it in webServerSettings.publicIp, which `webServer.get` returns.
// Any member's DNS instructions ask for it, so anyone may, but it runs on the
// panel host: for everyone but the instance administrator a recent result
// stands, and at most one lookup an hour reaches the host.
export const detectPublicIp = mutation({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		const { userId } = await requireMember(ctx, organizationId);
		const rootOrganizationId = await getRootOrganizationId(ctx);
		if (!rootOrganizationId) {
			throw new ConvexError("Instance is not initialized");
		}
		const admin = await requireInstanceAdmin(ctx).then(
			() => true,
			() => false,
		);
		const checkedAt = (await loadWebServerSettings(ctx))?.publicIpCheckedAt;
		if (
			!admin &&
			checkedAt !== undefined &&
			Date.now() - checkedAt < PUBLIC_IP_REFRESH_MS
		) {
			return null;
		}
		for (const status of ["queued", "running"] as const) {
			const pending = await ctx.db
				.query("jobs")
				.withIndex("by_group_and_status", (q) =>
					q.eq("group", PUBLIC_IP_GROUP).eq("status", status),
				)
				.first();
			if (pending) return pending._id;
		}
		return await enqueueHostJob(
			ctx,
			{
				organizationId: rootOrganizationId,
				partition: LOCAL_PARTITION,
				userId,
			},
			PUBLIC_IP_GROUP,
			{ kind: "infra.publicIp" },
			{ idempotent: true, maxAttempts: 2 },
		);
	},
});
