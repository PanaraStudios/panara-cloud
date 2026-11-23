import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { type ActionCtx, internalAction } from "../_generated/server";
import { errorMessage, providerFetch } from "./lib/fetch";
import {
	buildChannelRequest,
	buildMessage,
	type Credentials,
	type NotificationChannel,
	type NotificationMessage,
	notificationEvent,
} from "./lib/notificationMessages";

export const sendMessage = async (
	ctx: ActionCtx,
	channel: NotificationChannel,
	credentials: Credentials,
	message: NotificationMessage,
) => {
	const request = buildChannelRequest(channel, credentials, message);
	if (request.kind === "smtp") {
		const { kind: _, ...mail } = request;
		await ctx.runAction(internal.platform.notificationsNode.sendSmtp, mail);
		return;
	}
	const response = await providerFetch(request.url, request.init);
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new ConvexError(
			`Failed to send ${channel.type} notification: ${response.status} ${response.statusText} ${body.slice(0, 500)}`.trim(),
		);
	}
};

export const deliver = internalAction({
	args: {
		notificationId: v.id("notifications"),
		event: notificationEvent,
		sentAt: v.number(),
	},
	handler: async (ctx, { notificationId, event, sentAt }) => {
		const target = await ctx.runQuery(
			internal.platform.notifications.loadForDelivery,
			{ notificationId },
		);
		if (!target) return;
		try {
			await sendMessage(
				ctx,
				target.channel,
				target.credentials,
				buildMessage(event, sentAt),
			);
		} catch (error) {
			console.error(
				`Notification "${target.name}" (${target.channel.type}) failed for ${event.type}: ${errorMessage(error)}`,
			);
		}
	},
});
