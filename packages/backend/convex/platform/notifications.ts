import { ConvexError, type Infer, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	action,
	internalMutation,
	internalQuery,
	type MutationCtx,
	mutation,
	query,
} from "../_generated/server";
import { getRootOrganizationId } from "../infra/access";
import { requirePermission } from "../lib/permissions";
import { notificationChannel, notificationEvents } from "../tables/platform";
import {
	buildTestMessage,
	type Credentials,
	INSTANCE_EVENTS,
	type NotificationEvent,
	normalizeCredentials,
	notificationEvent,
	validateChannel,
} from "./lib/notificationMessages";
import {
	deleteSecret,
	encryptFields,
	hasSecret,
	readSecretFields,
	writeSecret,
} from "./lib/secrets";
import { sendMessage } from "./notificationDelivery";

export { notificationEvent } from "./lib/notificationMessages";

export const NOTIFICATION_SECRET_KIND = "platform.notification";
const MAX_NOTIFICATIONS = 100;
const MAX_INSTANCE_FANOUT = 500;

const credentialsValidator = v.record(v.string(), v.string());
const encrypted = v.object({ iv: v.string(), ciphertext: v.string() });

const toPublic = (doc: Doc<"notifications">) => ({
	_id: doc._id,
	_creationTime: doc._creationTime,
	organizationId: doc.organizationId,
	name: doc.name,
	channel: doc.channel,
	events: doc.events,
});

const asError = (error: unknown) =>
	new ConvexError(error instanceof Error ? error.message : String(error));

export const list = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requirePermission(ctx, organizationId, "notification", "read");
		const docs = await ctx.db
			.query("notifications")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_NOTIFICATIONS);
		return docs.map(toPublic);
	},
});

export const get = query({
	args: { notificationId: v.id("notifications") },
	handler: async (ctx, { notificationId }) => {
		const doc = await ctx.db.get("notifications", notificationId);
		if (!doc) return null;
		await requirePermission(ctx, doc.organizationId, "notification", "read");
		return {
			...toPublic(doc),
			hasCredentials: await hasSecret(
				ctx,
				NOTIFICATION_SECRET_KIND,
				notificationId,
			),
		};
	},
});

const checkName = (name: string) => {
	const trimmed = name.trim();
	if (!trimmed) throw new ConvexError("Name is required");
	return trimmed;
};

export const create = action({
	args: {
		organizationId: v.string(),
		name: v.string(),
		channel: notificationChannel,
		events: notificationEvents,
		credentials: credentialsValidator,
	},
	handler: async (ctx, args): Promise<Id<"notifications">> => {
		let credentials: Credentials;
		try {
			validateChannel(args.channel);
			credentials = normalizeCredentials(args.channel.type, args.credentials);
		} catch (error) {
			throw asError(error);
		}
		return await ctx.runMutation(internal.platform.notifications.insert, {
			organizationId: args.organizationId,
			name: checkName(args.name),
			channel: args.channel,
			events: args.events,
			secret: await encryptFields(credentials),
		});
	},
});

export const insert = internalMutation({
	args: {
		organizationId: v.string(),
		name: v.string(),
		channel: notificationChannel,
		events: notificationEvents,
		secret: encrypted,
	},
	handler: async (ctx, { secret, ...doc }) => {
		await requirePermission(ctx, doc.organizationId, "notification", "create");
		const notificationId = await ctx.db.insert("notifications", doc);
		await writeSecret(ctx, {
			organizationId: doc.organizationId,
			kind: NOTIFICATION_SECRET_KIND,
			ownerId: notificationId,
			secret,
		});
		return notificationId;
	},
});

// Where a channel delivers to; stored credentials only follow a channel
// whose destination stays the same.
const ENDPOINT_KEYS = ["smtpServer", "smtpPort", "serverUrl", "endpoint"];
const endpointOf = (channel: Infer<typeof notificationChannel>) =>
	JSON.stringify(
		ENDPOINT_KEYS.map((key) => (channel as Record<string, unknown>)[key]),
	);

const storedCredentialsFor = (
	current: {
		channel: Infer<typeof notificationChannel>;
		credentials: Credentials;
	},
	channel: Infer<typeof notificationChannel>,
	entered: Credentials | undefined,
): Credentials => {
	if (channel.type !== current.channel.type) return {};
	if (endpointOf(channel) === endpointOf(current.channel)) {
		return current.credentials;
	}
	if (Object.keys(current.credentials).length > 0 && !entered) {
		throw new ConvexError(
			"Enter the credentials again when changing where notifications are sent",
		);
	}
	return {};
};

export const update = action({
	args: {
		notificationId: v.id("notifications"),
		name: v.optional(v.string()),
		channel: v.optional(notificationChannel),
		events: v.optional(notificationEvents),
		// Omitted keys keep their stored values unless the channel type changes.
		credentials: v.optional(credentialsValidator),
	},
	handler: async (ctx, args): Promise<null> => {
		const current = await ctx.runQuery(
			internal.platform.notifications.loadForAdmin,
			{ notificationId: args.notificationId },
		);
		const channel = args.channel ?? current.channel;
		let secret: Infer<typeof encrypted> | undefined;
		if (args.channel || args.credentials) {
			const stored = storedCredentialsFor(current, channel, args.credentials);
			try {
				validateChannel(channel);
				const merged = normalizeCredentials(channel.type, {
					...stored,
					...args.credentials,
				});
				secret = await encryptFields(merged);
			} catch (error) {
				throw asError(error);
			}
		}
		await ctx.runMutation(internal.platform.notifications.patch, {
			notificationId: args.notificationId,
			name: args.name === undefined ? undefined : checkName(args.name),
			channel: args.channel,
			events: args.events,
			secret,
		});
		return null;
	},
});

export const patch = internalMutation({
	args: {
		notificationId: v.id("notifications"),
		name: v.optional(v.string()),
		channel: v.optional(notificationChannel),
		events: v.optional(notificationEvents),
		secret: v.optional(encrypted),
	},
	handler: async (ctx, { notificationId, secret, ...fields }) => {
		const doc = await ctx.db.get("notifications", notificationId);
		if (!doc) throw new ConvexError("Notification not found");
		await requirePermission(ctx, doc.organizationId, "notification", "update");
		await ctx.db.patch("notifications", notificationId, {
			...(fields.name !== undefined ? { name: fields.name } : {}),
			...(fields.channel ? { channel: fields.channel } : {}),
			...(fields.events ? { events: fields.events } : {}),
		});
		if (secret) {
			await writeSecret(ctx, {
				organizationId: doc.organizationId,
				kind: NOTIFICATION_SECRET_KIND,
				ownerId: notificationId,
				secret,
			});
		}
	},
});

export const remove = mutation({
	args: { notificationId: v.id("notifications") },
	handler: async (ctx, { notificationId }) => {
		const doc = await ctx.db.get("notifications", notificationId);
		if (!doc) return;
		await requirePermission(ctx, doc.organizationId, "notification", "delete");
		await deleteSecret(ctx, NOTIFICATION_SECRET_KIND, notificationId);
		await ctx.db.delete("notifications", notificationId);
	},
});

export const loadForAdmin = internalQuery({
	args: { notificationId: v.id("notifications") },
	handler: async (ctx, { notificationId }) => {
		const doc = await ctx.db.get("notifications", notificationId);
		if (!doc) throw new ConvexError("Notification not found");
		await requirePermission(ctx, doc.organizationId, "notification", "update");
		return {
			channel: doc.channel,
			credentials:
				(await readSecretFields(
					ctx,
					NOTIFICATION_SECRET_KIND,
					notificationId,
				)) ?? {},
		};
	},
});

export const assertAdmin = internalQuery({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requirePermission(ctx, organizationId, "notification", "create");
		return null;
	},
});

export const loadForDelivery = internalQuery({
	args: { notificationId: v.id("notifications") },
	handler: async (ctx, { notificationId }) => {
		const doc = await ctx.db.get("notifications", notificationId);
		if (!doc) return null;
		return {
			name: doc.name,
			channel: doc.channel,
			credentials:
				(await readSecretFields(
					ctx,
					NOTIFICATION_SECRET_KIND,
					notificationId,
				)) ?? {},
		};
	},
});

// Sends a test message either through a saved notification or through an
// unsaved channel configuration (the "Test connection" buttons).
export const test = action({
	args: {
		notificationId: v.optional(v.id("notifications")),
		organizationId: v.optional(v.string()),
		channel: v.optional(notificationChannel),
		credentials: v.optional(credentialsValidator),
	},
	handler: async (ctx, args): Promise<null> => {
		let channel: Infer<typeof notificationChannel>;
		let credentials: Credentials;
		if (args.notificationId) {
			const saved = await ctx.runQuery(
				internal.platform.notifications.loadForAdmin,
				{ notificationId: args.notificationId },
			);
			channel = args.channel ?? saved.channel;
			credentials = {
				...storedCredentialsFor(saved, channel, args.credentials),
				...args.credentials,
			};
		} else {
			if (!args.organizationId || !args.channel) {
				throw new ConvexError(
					"Provide a notificationId or an organizationId with a channel",
				);
			}
			await ctx.runQuery(internal.platform.notifications.assertAdmin, {
				organizationId: args.organizationId,
			});
			channel = args.channel;
			credentials = args.credentials ?? {};
		}
		try {
			validateChannel(channel);
			await sendMessage(
				ctx,
				channel,
				normalizeCredentials(channel.type, credentials),
				buildTestMessage(Date.now()),
			);
		} catch (error) {
			throw new ConvexError(
				`Error testing the notification: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return null;
	},
});

// Entry point for other domains when something notifiable happens. Pass
// `organizationId: null` for instance-wide events (panelRestart, panelBackup).
export const dispatch = internalMutation({
	args: {
		organizationId: v.union(v.string(), v.null()),
		event: notificationEvent,
	},
	handler: async (ctx, { organizationId, event }) => {
		const key = event.type;
		let targets: Doc<"notifications">[];
		if (INSTANCE_EVENTS.has(key) && organizationId === null) {
			// Panel events describe the instance itself: only the root
			// organization (the instance administrator's) hears about them.
			const root = await getRootOrganizationId(ctx);
			const all =
				key === "panelRestart"
					? await ctx.db
							.query("notifications")
							.withIndex("by_events_panelRestart", (q) =>
								q.eq("events.panelRestart", true),
							)
							.take(MAX_INSTANCE_FANOUT)
					: await ctx.db
							.query("notifications")
							.withIndex("by_events_panelBackup", (q) =>
								q.eq("events.panelBackup", true),
							)
							.take(MAX_INSTANCE_FANOUT);
			targets = all.filter((doc) => doc.organizationId === root);
		} else {
			if (organizationId === null) {
				throw new ConvexError(`Event "${key}" requires an organizationId`);
			}
			const docs = await ctx.db
				.query("notifications")
				.withIndex("by_organizationId", (q) =>
					q.eq("organizationId", organizationId),
				)
				.take(MAX_NOTIFICATIONS);
			targets = docs.filter((doc) => doc.events[key]);
		}
		const sentAt = Date.now();
		for (const doc of targets) {
			await ctx.scheduler.runAfter(
				0,
				internal.platform.notificationDelivery.deliver,
				{ notificationId: doc._id, event, sentAt },
			);
		}
		return targets.length;
	},
});

export const dispatchNotification = (
	ctx: MutationCtx,
	args: { organizationId: string | null; event: NotificationEvent },
) => ctx.scheduler.runAfter(0, internal.platform.notifications.dispatch, args);
