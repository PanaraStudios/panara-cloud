import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
	internalMutation,
	internalQuery,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "../_generated/server";
import { assertPanelHostAllowed } from "../infra/access";
import { requireUserId } from "../lib/access";
import { enqueueJob } from "../lib/jobs";
import { requirePermission } from "../lib/permissions";
import { LOCAL_PARTITION } from "../tables/core";
import { telemetryProviderType, telemetrySignal } from "../tables/platform";
import { deleteSecret, readSecretFields, writeSecret } from "./lib/secrets";
import { availableTelemetryTypes } from "./lib/telemetryAdapters";
import type { VectorProvider } from "./lib/vectorConfig";

export const TELEMETRY_SECRET_KIND = "platform.telemetryProvider";

const MAX_PROVIDERS = 200;
const MAX_TARGETS = 500;

const encrypted = v.object({ iv: v.string(), ciphertext: v.string() });

export const toVectorProvider = async (
	ctx: QueryCtx,
	provider: Doc<"telemetryProviders">,
): Promise<VectorProvider> => {
	const secrets =
		(await readSecretFields(ctx, TELEMETRY_SECRET_KIND, provider._id)) ?? {};
	return {
		telemetryProviderId: provider._id,
		name: provider.name,
		providerType: provider.providerType,
		signals: provider.signals,
		endpoint: secrets.endpoint ?? null,
		apiKey: secrets.apiKey ?? null,
		apiSecret: secrets.apiSecret ?? null,
		extraConfig: provider.extraConfig ?? null,
	};
};

const findLocalTarget = (ctx: QueryCtx) =>
	ctx.db
		.query("vectorTargets")
		.withIndex("by_serverId", (q) => q.eq("serverId", undefined))
		.first();

export const enqueueVectorReconcile = async (
	ctx: MutationCtx,
	target: Doc<"vectorTargets">,
	requestedBy?: string,
) => {
	const jobId = await enqueueJob(ctx, {
		organizationId: target.organizationId,
		partition: target.serverId ?? LOCAL_PARTITION,
		group: `vector:${target.serverId ?? "local"}`,
		spec: { kind: "platform.vectorReconcile", vectorTargetId: target._id },
		idempotent: true,
		maxAttempts: 3,
		requestedBy,
	});
	await ctx.db.patch("vectorTargets", target._id, { lastJobId: jobId });
	return jobId;
};

const targetsUsingProvider = async (
	ctx: QueryCtx,
	provider: Doc<"telemetryProviders">,
) => {
	const targets = await ctx.db
		.query("vectorTargets")
		.withIndex("by_organizationId", (q) =>
			q.eq("organizationId", provider.organizationId),
		)
		.take(MAX_TARGETS);
	return targets.filter((target) => target.providerIds.includes(provider._id));
};

const loadOwnedProvider = async (
	ctx: QueryCtx,
	telemetryProviderId: Id<"telemetryProviders">,
	action: "read" | "create" | "delete",
) => {
	const provider = await ctx.db.get("telemetryProviders", telemetryProviderId);
	if (!provider) throw new ConvexError("Provider not found");
	const { userId } = await requirePermission(
		ctx,
		provider.organizationId,
		"telemetryProvider",
		action,
	);
	return { provider, userId };
};

export const list = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requirePermission(ctx, organizationId, "telemetryProvider", "read");
		return await ctx.db
			.query("telemetryProviders")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_PROVIDERS);
	},
});

export const get = query({
	args: { telemetryProviderId: v.id("telemetryProviders") },
	handler: async (ctx, { telemetryProviderId }) => {
		const provider = await ctx.db.get(
			"telemetryProviders",
			telemetryProviderId,
		);
		if (!provider) return null;
		await requirePermission(
			ctx,
			provider.organizationId,
			"telemetryProvider",
			"read",
		);
		return provider;
	},
});

// Removing a provider drops it from every host selection and
// re-applies those hosts (an emptied selection removes the agent).
export const remove = mutation({
	args: { telemetryProviderId: v.id("telemetryProviders") },
	handler: async (ctx, { telemetryProviderId }) => {
		const provider = await ctx.db.get(
			"telemetryProviders",
			telemetryProviderId,
		);
		if (!provider) return { reapplied: 0, jobIds: [] };
		const { userId } = await requirePermission(
			ctx,
			provider.organizationId,
			"telemetryProvider",
			"delete",
		);
		const targets = await targetsUsingProvider(ctx, provider);
		for (const target of targets) {
			await ctx.db.patch("vectorTargets", target._id, {
				providerIds: target.providerIds.filter(
					(id) => id !== telemetryProviderId,
				),
			});
		}
		await deleteSecret(ctx, TELEMETRY_SECRET_KIND, telemetryProviderId);
		await ctx.db.delete("telemetryProviders", telemetryProviderId);
		const jobIds: Id<"jobs">[] = [];
		for (const target of targets) {
			const updated = await ctx.db.get("vectorTargets", target._id);
			if (updated)
				jobIds.push(await enqueueVectorReconcile(ctx, updated, userId));
		}
		return { reapplied: targets.length, jobIds };
	},
});

export const setVectorTargetProviders = mutation({
	args: {
		organizationId: v.string(),
		serverId: v.optional(v.id("servers")),
		providerIds: v.array(v.id("telemetryProviders")),
	},
	handler: async (ctx, { organizationId, serverId, providerIds }) => {
		const { userId } = await requirePermission(
			ctx,
			organizationId,
			"telemetryProvider",
			"create",
		);
		// The panel host's agent ships panel-wide host metrics: only the
		// instance administrator assigns it, and may take it back.
		await assertPanelHostAllowed(ctx, organizationId, serverId);
		if (serverId) {
			const server = await ctx.db.get("servers", serverId);
			if (!server || server.organizationId !== organizationId) {
				throw new ConvexError("Server not found");
			}
			if (!server.sshKeyId) {
				throw new ConvexError(
					"This server has no SSH key, so the Vector agent can't be managed on it",
				);
			}
		}
		const unique = [...new Set(providerIds)];
		if (unique.length > 0) {
			let anyEnabled = false;
			for (const id of unique) {
				const provider = await ctx.db.get("telemetryProviders", id);
				if (!provider || provider.organizationId !== organizationId) {
					throw new ConvexError(
						"One of the selected providers is not in this organization",
					);
				}
				anyEnabled ||= provider.enabled;
			}
			if (!anyEnabled) {
				throw new ConvexError(
					"Select at least one enabled provider — a disabled one ships nothing.",
				);
			}
		}

		const existing = serverId
			? await ctx.db
					.query("vectorTargets")
					.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
					.first()
			: await findLocalTarget(ctx);
		if (
			serverId &&
			existing &&
			existing.organizationId !== organizationId &&
			existing.providerIds.length > 0
		) {
			throw new ConvexError(
				"The local Vector agent is claimed by another organization",
			);
		}
		let targetId: Id<"vectorTargets">;
		if (existing) {
			await ctx.db.patch("vectorTargets", existing._id, {
				organizationId,
				providerIds: unique,
			});
			targetId = existing._id;
		} else {
			targetId = await ctx.db.insert("vectorTargets", {
				organizationId,
				serverId,
				providerIds: unique,
			});
		}
		const target = await ctx.db.get("vectorTargets", targetId);
		if (!target) throw new ConvexError("Vector target vanished");
		const jobId = await enqueueVectorReconcile(ctx, target, userId);
		return { vectorTargetId: targetId, jobId };
	},
});

export const vectorStatus = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requirePermission(ctx, organizationId, "telemetryProvider", "read");
		const [servers, targets, local] = await Promise.all([
			ctx.db
				.query("servers")
				.withIndex("by_organizationId", (q) =>
					q.eq("organizationId", organizationId),
				)
				.take(MAX_TARGETS),
			ctx.db
				.query("vectorTargets")
				.withIndex("by_organizationId", (q) =>
					q.eq("organizationId", organizationId),
				)
				.take(MAX_TARGETS),
			findLocalTarget(ctx),
		]);
		const byServer = new Map(
			targets
				.filter((t) => t.serverId !== undefined)
				.map((t) => [t.serverId, t]),
		);
		const lastJob = async (target: Doc<"vectorTargets"> | undefined) => {
			if (!target?.lastJobId) return null;
			const job = await ctx.db.get("jobs", target.lastJobId);
			return job
				? {
						jobId: job._id,
						status: job.status,
						error: job.error ?? null,
						finishedAt: job.finishedAt ?? null,
					}
				: null;
		};
		const localVisible =
			!local ||
			local.organizationId === organizationId ||
			local.providerIds.length === 0;
		const localOwned = local?.organizationId === organizationId;
		const result = [];
		if (localVisible) {
			result.push({
				serverId: null,
				name: "Panara Cloud Server (local)",
				ipAddress: null,
				hasSshKey: true,
				providerIds: localOwned && local ? local.providerIds : [],
				lastJob: localOwned ? await lastJob(local ?? undefined) : null,
			});
		}
		for (const server of servers) {
			const target = byServer.get(server._id);
			result.push({
				serverId: server._id,
				name: server.name,
				ipAddress: server.ipAddress,
				hasSshKey: !!server.sshKeyId,
				providerIds: target?.providerIds ?? [],
				lastJob: await lastJob(target),
			});
		}
		return result;
	},
});

export const loadForAction = internalQuery({
	args: { telemetryProviderId: v.id("telemetryProviders") },
	handler: async (ctx, { telemetryProviderId }) => {
		const { provider } = await loadOwnedProvider(
			ctx,
			telemetryProviderId,
			"create",
		);
		return {
			provider,
			runtime: await toVectorProvider(ctx, provider),
		};
	},
});

const providerFields = {
	name: v.string(),
	providerType: telemetryProviderType,
	signals: v.array(telemetrySignal),
	extraConfig: v.optional(v.record(v.string(), v.any())),
	enabled: v.boolean(),
};

export const insert = internalMutation({
	args: {
		organizationId: v.string(),
		...providerFields,
		secret: encrypted,
	},
	handler: async (ctx, { secret, ...fields }) => {
		await requirePermission(
			ctx,
			fields.organizationId,
			"telemetryProvider",
			"create",
		);
		const telemetryProviderId = await ctx.db.insert(
			"telemetryProviders",
			fields,
		);
		await writeSecret(ctx, {
			organizationId: fields.organizationId,
			kind: TELEMETRY_SECRET_KIND,
			ownerId: telemetryProviderId,
			secret,
		});
		return telemetryProviderId;
	},
});

export const replace = internalMutation({
	args: {
		telemetryProviderId: v.id("telemetryProviders"),
		...providerFields,
		secret: encrypted,
		shippingChanged: v.boolean(),
	},
	handler: async (
		ctx,
		{ telemetryProviderId, secret, shippingChanged, ...fields },
	) => {
		const { provider, userId } = await loadOwnedProvider(
			ctx,
			telemetryProviderId,
			"create",
		);
		await ctx.db.replace("telemetryProviders", telemetryProviderId, {
			organizationId: provider.organizationId,
			...fields,
		});
		await writeSecret(ctx, {
			organizationId: provider.organizationId,
			kind: TELEMETRY_SECRET_KIND,
			ownerId: telemetryProviderId,
			secret,
		});
		if (!shippingChanged) return { reapplied: 0, jobIds: [] };
		const targets = await targetsUsingProvider(ctx, provider);
		const jobIds: Id<"jobs">[] = [];
		for (const target of targets) {
			jobIds.push(await enqueueVectorReconcile(ctx, target, userId));
		}
		return { reapplied: targets.length, jobIds };
	},
});

export const availableTypes = query({
	args: {},
	handler: async (ctx) => {
		await requireUserId(ctx);
		return availableTelemetryTypes();
	},
});

export const assertAdmin = internalQuery({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requirePermission(ctx, organizationId, "telemetryProvider", "create");
		return null;
	},
});
