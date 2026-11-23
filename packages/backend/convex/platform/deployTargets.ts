import { ConvexError, v } from "convex/values";
import { mutation, type QueryCtx, query } from "../_generated/server";
import { requireInstanceAdmin } from "../infra/access";
import {
	DEFAULT_WEB_SERVER_SETTINGS,
	loadWebServerSettings,
} from "../infra/webServer";
import { requireCaller } from "../lib/access";

export const isRemoteServersOnly = async (ctx: QueryCtx) =>
	(await loadWebServerSettings(ctx))?.remoteServersOnly === true;

// "Remote Servers Only": new services can't target the panel host.
export const assertPanelHostAllowed = async (ctx: QueryCtx) => {
	if (await isRemoteServersOnly(ctx)) {
		throw new ConvexError(
			"Remote servers only is enabled: select a server for this service",
		);
	}
};

// The panel host runs Panara Cloud itself, so only the instance administrator
// may place services of the root organization on it.
export const assertPanelHostTarget = async (
	ctx: QueryCtx,
	organizationId: string,
) => {
	await assertPanelHostAllowed(ctx);
	const { organizationId: root } = await requireInstanceAdmin(ctx).catch(() => {
		throw new ConvexError(
			"Only the instance administrator can deploy to the Panara Cloud server: select a server for this service",
		);
	});
	if (root !== organizationId) {
		throw new ConvexError("Select a server for this service");
	}
};

// Readable by every signed-in user: create dialogs and server pickers hide
// the panel host when it is set.
export const remoteServersOnly = query({
	args: {},
	handler: async (ctx) => {
		await requireCaller(ctx);
		return await isRemoteServersOnly(ctx);
	},
});

export const setRemoteServersOnly = mutation({
	args: { remoteServersOnly: v.boolean() },
	handler: async (ctx, { remoteServersOnly }) => {
		await requireInstanceAdmin(ctx);
		const current = await loadWebServerSettings(ctx);
		if (current) {
			await ctx.db.patch("webServerSettings", current._id, {
				remoteServersOnly,
			});
		} else {
			await ctx.db.insert("webServerSettings", {
				...DEFAULT_WEB_SERVER_SETTINGS,
				remoteServersOnly,
			});
		}
	},
});
