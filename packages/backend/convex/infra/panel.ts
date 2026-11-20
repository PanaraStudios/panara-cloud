import { ConvexError, v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireMember } from "../lib/access";
import { LOCAL_PARTITION } from "../tables/core";
import { panelAction } from "../tables/infra";
import { getRootOrganizationId, requireInstanceAdmin } from "./access";
import { enqueueHostJob, enqueueOp } from "./hostJobs";
import { loadWebServerSettings } from "./webServer";

export const PANEL_PORT = 3000;
const PANEL_GROUP = `panel:${LOCAL_PARTITION}`;
const PUBLIC_IP_GROUP = `publicIp:${LOCAL_PARTITION}`;

// Disabling port 3000 is only allowed from
// the panel domain, so the admin doesn't lock themselves out.
export const isPanelHostRequest = (
	currentHost: string | undefined,
	panelHost: string | undefined,
) => {
	if (!currentHost || !panelHost) return false;
	try {
		const { hostname, port } = new URL(`http://${currentHost}`);
		if (Number(port) === PANEL_PORT) return false;
		return hostname === panelHost.trim().toLowerCase();
	} catch {
		return false;
	}
};

// Reload, version check, self-update and the port 3000 toggle of the panel
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
					"Configure a domain for the Panara Cloud panel before disabling port 3000",
				);
			}
			if (!isPanelHostRequest(currentHost, settings.host)) {
				throw new ConvexError(
					`Access the panel through ${settings.host} to disable port 3000`,
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

// Public IP lookup (any signed-in user): the agent looks up the
// panel host's public address and stores it in webServerSettings.publicIp,
// which `webServer.get` returns.
export const detectPublicIp = mutation({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		const { userId } = await requireMember(ctx, organizationId);
		const rootOrganizationId = await getRootOrganizationId(ctx);
		if (!rootOrganizationId) {
			throw new ConvexError("Instance is not initialized");
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
