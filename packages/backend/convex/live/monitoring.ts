import { ConvexError, type Infer, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	action,
	internalMutation,
	type MutationCtx,
	mutation,
	query,
} from "../_generated/server";
import { encryptSecret, sha256Hex } from "../lib/crypto";
import { enqueueJob } from "../lib/jobs";
import { putSecret } from "../lib/secrets";
import { dispatchNotification } from "../platform/notifications";
import { monitoringSettings } from "../tables/live";
import { MONITORING_TOKEN_KIND, requireHostAdmin } from "./lib";

type MonitoringSettings = Infer<typeof monitoringSettings>;

// One alert per metric per host in this window; the monitoring container
// re-sends on every refresh while a threshold stays exceeded.
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export const DEFAULT_MONITORING_SETTINGS: MonitoringSettings = {
	refreshRate: 60,
	port: 4500,
	retentionDays: 2,
	cronJob: "0 0 * * *",
	thresholds: { cpu: 0, memory: 0 },
	containers: { refreshRate: 60, include: [], exclude: [] },
};

const validateSettings = (settings: MonitoringSettings) => {
	const int = (value: number, min: number, max: number, label: string) => {
		if (!Number.isInteger(value) || value < min || value > max) {
			throw new ConvexError(`${label} must be between ${min} and ${max}`);
		}
	};
	int(settings.refreshRate, 2, 86_400, "Refresh rate");
	int(settings.containers.refreshRate, 2, 86_400, "Container refresh rate");
	int(settings.port, 1024, 65_535, "Port");
	int(settings.retentionDays, 1, 365, "Retention days");
	int(settings.thresholds.cpu, 0, 100, "CPU threshold");
	int(settings.thresholds.memory, 0, 100, "Memory threshold");
	if (!/^[0-9*/,\- ]{9,64}$/.test(settings.cronJob)) {
		throw new ConvexError("Invalid cleanup cron expression");
	}
	for (const name of [
		...settings.containers.include,
		...settings.containers.exclude,
	]) {
		if (!SERVICE_NAME.test(name)) {
			throw new ConvexError(`Invalid service name: ${name}`);
		}
	}
	if (
		settings.containers.include.length + settings.containers.exclude.length >
		500
	) {
		throw new ConvexError("Too many services in the include/exclude lists");
	}
};

const monitoringGroup = (partition: string) => `monitoring:${partition}`;

export const get = query({
	args: { organizationId: v.string(), serverId: v.optional(v.id("servers")) },
	handler: async (ctx, { organizationId, serverId }) => {
		await requireHostAdmin(ctx, organizationId, serverId);
		const config = await ctx.db
			.query("monitoringConfigs")
			.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
			.unique();
		if (!config) {
			return {
				settings: DEFAULT_MONITORING_SETTINGS,
				enabled: false,
				configured: false,
				lastJobId: null,
			};
		}
		return {
			settings: config.settings,
			enabled: config.enabled,
			configured: true,
			lastJobId: config.lastJobId ?? null,
		};
	},
});

export const upsertConfig = internalMutation({
	args: {
		organizationId: v.string(),
		serverId: v.optional(v.id("servers")),
		settings: monitoringSettings,
		rotateToken: v.boolean(),
		token: v.object({
			hash: v.string(),
			iv: v.string(),
			ciphertext: v.string(),
		}),
	},
	handler: async (ctx, args) => {
		const scope = await requireHostAdmin(
			ctx,
			args.organizationId,
			args.serverId,
		);
		const existing = await ctx.db
			.query("monitoringConfigs")
			.withIndex("by_serverId", (q) => q.eq("serverId", args.serverId))
			.unique();
		const newToken = !existing || args.rotateToken;
		let configId: Id<"monitoringConfigs">;
		if (existing) {
			configId = existing._id;
			await ctx.db.patch("monitoringConfigs", existing._id, {
				settings: args.settings,
				...(newToken && { tokenHash: args.token.hash }),
			});
		} else {
			configId = await ctx.db.insert("monitoringConfigs", {
				organizationId: scope.organizationId,
				serverId: args.serverId,
				settings: args.settings,
				tokenHash: args.token.hash,
				enabled: false,
			});
		}
		if (newToken) {
			await putSecret(ctx, {
				organizationId: scope.organizationId,
				kind: MONITORING_TOKEN_KIND,
				ownerId: configId,
				iv: args.token.iv,
				ciphertext: args.token.ciphertext,
			});
		}
		const config = await ctx.db.get("monitoringConfigs", configId);
		// A running monitoring container picks up new settings only when redeployed.
		if (config?.enabled) {
			const jobId = await enqueueJob(ctx, {
				organizationId: scope.organizationId,
				partition: scope.partition,
				group: monitoringGroup(scope.partition),
				spec: { kind: "live.monitoringSetup", serverId: args.serverId },
				idempotent: true,
				requestedBy: scope.userId,
			});
			await ctx.db.patch("monitoringConfigs", configId, { lastJobId: jobId });
		}
		return configId;
	},
});

// Saves the monitoring settings for a host. The bearer token is generated
// here (actions have an unseeded random source) and only used when the host
// has none yet or `rotateToken` is set.
export const configure = action({
	args: {
		organizationId: v.string(),
		serverId: v.optional(v.id("servers")),
		settings: monitoringSettings,
		rotateToken: v.optional(v.boolean()),
	},
	handler: async (ctx, args): Promise<Id<"monitoringConfigs">> => {
		validateSettings(args.settings);
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		const token = Array.from(bytes, (b) =>
			b.toString(16).padStart(2, "0"),
		).join("");
		const encrypted = await encryptSecret(token);
		return await ctx.runMutation(internal.live.monitoring.upsertConfig, {
			organizationId: args.organizationId,
			serverId: args.serverId,
			settings: args.settings,
			rotateToken: args.rotateToken ?? false,
			token: { hash: await sha256Hex(token), ...encrypted },
		});
	},
});

const setEnabled = async (
	ctx: MutationCtx,
	organizationId: string,
	serverId: Id<"servers"> | undefined,
	enable: boolean,
) => {
	const scope = await requireHostAdmin(ctx, organizationId, serverId);
	const config = await ctx.db
		.query("monitoringConfigs")
		.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
		.unique();
	if (!config) throw new ConvexError("Configure monitoring first");
	const jobId = await enqueueJob(ctx, {
		organizationId: scope.organizationId,
		partition: scope.partition,
		group: monitoringGroup(scope.partition),
		spec: enable
			? { kind: "live.monitoringSetup", serverId }
			: { kind: "live.monitoringRemove", serverId },
		idempotent: true,
		requestedBy: scope.userId,
	});
	await ctx.db.patch("monitoringConfigs", config._id, {
		enabled: enable,
		lastJobId: jobId,
	});
	return jobId;
};

// Deploys (or redeploys) the monitoring service on the host.
export const setup = mutation({
	args: { organizationId: v.string(), serverId: v.optional(v.id("servers")) },
	handler: (ctx, { organizationId, serverId }) =>
		setEnabled(ctx, organizationId, serverId, true),
});

export const remove = mutation({
	args: { organizationId: v.string(), serverId: v.optional(v.id("servers")) },
	handler: (ctx, { organizationId, serverId }) =>
		setEnabled(ctx, organizationId, serverId, false),
});

// Threshold callback from the monitoring container (authenticated by its
// token), forwarded as a serverThreshold notification.
export const receiveAlert = internalMutation({
	args: {
		tokenHash: v.string(),
		metric: v.union(v.literal("CPU"), v.literal("Memory")),
		value: v.number(),
		threshold: v.number(),
		message: v.string(),
		timestamp: v.number(),
	},
	handler: async (ctx, args) => {
		const config = await ctx.db
			.query("monitoringConfigs")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
			.unique();
		if (!config) return { ok: false as const, reason: "unknown token" };
		const key = args.metric === "CPU" ? "cpu" : "memory";
		const now = Date.now();
		const last = config.lastAlerts?.[key];
		if (last !== undefined && now - last < ALERT_COOLDOWN_MS) {
			return { ok: true as const, dispatched: false };
		}
		await ctx.db.patch("monitoringConfigs", config._id, {
			lastAlerts: { ...config.lastAlerts, [key]: now },
		});
		const server = config.serverId
			? await ctx.db.get("servers", config.serverId)
			: null;
		await dispatchNotification(ctx, {
			organizationId: config.organizationId,
			event: {
				type: "serverThreshold",
				serverName: server?.name ?? "Panara Cloud",
				metric: args.metric,
				value: args.value,
				threshold: args.threshold,
				message: args.message.slice(0, 500),
				timestamp: args.timestamp,
			},
		});
		return { ok: true as const, dispatched: true };
	},
});
