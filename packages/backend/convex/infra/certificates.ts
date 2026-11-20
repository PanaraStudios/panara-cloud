import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	action,
	internalMutation,
	type MutationCtx,
	mutation,
	query,
} from "../_generated/server";
import { requireMember } from "../lib/access";
import { encryptSecret } from "../lib/crypto";
import { enqueueJob } from "../lib/jobs";
import { requirePermission } from "../lib/permissions";
import { assertPanelHostAllowed, partitionOf } from "./access";

export const CERTIFICATE_KEY_SECRET = "infra.certificateKey";
const MAX_CERTIFICATES = 200;
const MAX_PEM_LENGTH = 64 * 1024;

const validatePem = (certificateData: string, privateKey: string) => {
	if (!/-----BEGIN CERTIFICATE-----/.test(certificateData)) {
		throw new ConvexError("Certificate must be PEM encoded");
	}
	if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
		throw new ConvexError("Private key must be PEM encoded");
	}
	if (
		certificateData.length > MAX_PEM_LENGTH ||
		privateKey.length > MAX_PEM_LENGTH
	) {
		throw new ConvexError("Certificate or key is too large");
	}
};

const enqueueSync = (
	ctx: MutationCtx,
	certificate: {
		_id: Id<"certificates">;
		organizationId: string;
		serverId?: Id<"servers">;
	},
	requestedBy: string,
) =>
	enqueueJob(ctx, {
		organizationId: certificate.organizationId,
		partition: partitionOf(certificate.serverId),
		group: `certificate:${certificate._id}`,
		spec: { kind: "infra.certificateSync", certificateId: certificate._id },
		idempotent: true,
		maxAttempts: 3,
		requestedBy,
	});

export const list = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requirePermission(ctx, organizationId, "certificate", "read");
		return await ctx.db
			.query("certificates")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_CERTIFICATES);
	},
});

// The certificates screen: each certificate with its public chain (expiry
// and CN are parsed in the browser) and its server.
export const listDetailed = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requirePermission(ctx, organizationId, "certificate", "read");
		const certificates = await ctx.db
			.query("certificates")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_CERTIFICATES);
		return await Promise.all(
			certificates.map(async (certificate) => {
				const chain = await ctx.db
					.query("certificateChains")
					.withIndex("by_certificateId", (q) =>
						q.eq("certificateId", certificate._id),
					)
					.unique();
				const server = certificate.serverId
					? await ctx.db.get("servers", certificate.serverId)
					: null;
				return {
					...certificate,
					certificateData: chain?.certificateData ?? "",
					server: server
						? { name: server.name, ipAddress: server.ipAddress }
						: null,
				};
			}),
		);
	},
});

// Returns the public chain; never the private key.
export const get = query({
	args: { certificateId: v.id("certificates") },
	handler: async (ctx, { certificateId }) => {
		const certificate = await ctx.db.get("certificates", certificateId);
		if (!certificate) return null;
		await requirePermission(
			ctx,
			certificate.organizationId,
			"certificate",
			"read",
		);
		const chain = await ctx.db
			.query("certificateChains")
			.withIndex("by_certificateId", (q) =>
				q.eq("certificateId", certificateId),
			)
			.unique();
		return { ...certificate, certificateData: chain?.certificateData ?? "" };
	},
});

export const create = action({
	args: {
		organizationId: v.string(),
		serverId: v.optional(v.id("servers")),
		name: v.string(),
		certificateData: v.string(),
		privateKey: v.string(),
		autoRenew: v.optional(v.boolean()),
	},
	handler: async (ctx, args): Promise<Id<"certificates">> => {
		const name = args.name.trim();
		if (!name) throw new ConvexError("Name is required");
		validatePem(args.certificateData, args.privateKey);
		const suffix = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) =>
			b.toString(16).padStart(2, "0"),
		).join("");
		return await ctx.runMutation(internal.infra.certificates.insert, {
			organizationId: args.organizationId,
			serverId: args.serverId,
			name,
			certificatePath: `certificate-${suffix}`,
			certificateData: args.certificateData.trim(),
			autoRenew: args.autoRenew,
			...(await encryptSecret(args.privateKey.trim())),
		});
	},
});

export const insert = internalMutation({
	args: {
		organizationId: v.string(),
		serverId: v.optional(v.id("servers")),
		name: v.string(),
		certificatePath: v.string(),
		certificateData: v.string(),
		autoRenew: v.optional(v.boolean()),
		iv: v.string(),
		ciphertext: v.string(),
	},
	handler: async (ctx, args) => {
		const { userId } = await requireMember(ctx, args.organizationId, "admin");
		await assertPanelHostAllowed(ctx, args.organizationId, args.serverId);
		if (args.serverId) {
			const server = await ctx.db.get("servers", args.serverId);
			if (!server || server.organizationId !== args.organizationId) {
				throw new ConvexError("Server not found");
			}
		}
		const certificateId = await ctx.db.insert("certificates", {
			organizationId: args.organizationId,
			serverId: args.serverId,
			name: args.name,
			certificatePath: args.certificatePath,
			autoRenew: args.autoRenew,
		});
		await ctx.db.insert("certificateChains", {
			organizationId: args.organizationId,
			certificateId,
			certificateData: args.certificateData,
		});
		await ctx.db.insert("secrets", {
			organizationId: args.organizationId,
			kind: CERTIFICATE_KEY_SECRET,
			ownerId: certificateId,
			iv: args.iv,
			ciphertext: args.ciphertext,
		});
		await enqueueSync(
			ctx,
			{
				_id: certificateId,
				organizationId: args.organizationId,
				serverId: args.serverId,
			},
			userId,
		);
		return certificateId;
	},
});

export const update = action({
	args: {
		certificateId: v.id("certificates"),
		name: v.optional(v.string()),
		certificateData: v.optional(v.string()),
		privateKey: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<null> => {
		if (args.certificateData !== undefined || args.privateKey !== undefined) {
			validatePem(
				args.certificateData ?? "-----BEGIN CERTIFICATE-----",
				args.privateKey ?? "-----BEGIN PRIVATE KEY-----",
			);
		}
		const encrypted = args.privateKey
			? await encryptSecret(args.privateKey.trim())
			: undefined;
		await ctx.runMutation(internal.infra.certificates.patch, {
			certificateId: args.certificateId,
			name: args.name?.trim() || undefined,
			certificateData: args.certificateData?.trim(),
			encryptedKey: encrypted,
		});
		return null;
	},
});

export const patch = internalMutation({
	args: {
		certificateId: v.id("certificates"),
		name: v.optional(v.string()),
		certificateData: v.optional(v.string()),
		encryptedKey: v.optional(
			v.object({ iv: v.string(), ciphertext: v.string() }),
		),
	},
	handler: async (ctx, args) => {
		const certificate = await ctx.db.get("certificates", args.certificateId);
		if (!certificate) throw new ConvexError("Certificate not found");
		const { userId } = await requireMember(
			ctx,
			certificate.organizationId,
			"admin",
		);
		await assertPanelHostAllowed(
			ctx,
			certificate.organizationId,
			certificate.serverId,
		);
		if (args.name) {
			await ctx.db.patch("certificates", certificate._id, { name: args.name });
		}
		if (args.certificateData) {
			const chain = await ctx.db
				.query("certificateChains")
				.withIndex("by_certificateId", (q) =>
					q.eq("certificateId", certificate._id),
				)
				.unique();
			if (chain) {
				await ctx.db.patch("certificateChains", chain._id, {
					certificateData: args.certificateData,
				});
			}
		}
		if (args.encryptedKey) {
			const secret = await ctx.db
				.query("secrets")
				.withIndex("by_kind_and_ownerId", (q) =>
					q.eq("kind", CERTIFICATE_KEY_SECRET).eq("ownerId", certificate._id),
				)
				.unique();
			if (secret) await ctx.db.patch("secrets", secret._id, args.encryptedKey);
		}
		if (args.certificateData || args.encryptedKey) {
			await enqueueSync(ctx, certificate, userId);
		}
	},
});

export const remove = mutation({
	args: { certificateId: v.id("certificates") },
	handler: async (ctx, { certificateId }) => {
		const certificate = await ctx.db.get("certificates", certificateId);
		if (!certificate) return;
		const { userId } = await requireMember(
			ctx,
			certificate.organizationId,
			"admin",
		);
		await assertPanelHostAllowed(
			ctx,
			certificate.organizationId,
			certificate.serverId,
		);
		const chain = await ctx.db
			.query("certificateChains")
			.withIndex("by_certificateId", (q) =>
				q.eq("certificateId", certificateId),
			)
			.unique();
		if (chain) await ctx.db.delete("certificateChains", chain._id);
		const secret = await ctx.db
			.query("secrets")
			.withIndex("by_kind_and_ownerId", (q) =>
				q.eq("kind", CERTIFICATE_KEY_SECRET).eq("ownerId", certificateId),
			)
			.unique();
		if (secret) await ctx.db.delete("secrets", secret._id);
		await ctx.db.delete("certificates", certificateId);
		await enqueueJob(ctx, {
			organizationId: certificate.organizationId,
			partition: partitionOf(certificate.serverId),
			group: `certificate:${certificateId}`,
			spec: {
				kind: "infra.certificateRemove",
				certificatePath: certificate.certificatePath,
			},
			idempotent: true,
			maxAttempts: 3,
			requestedBy: userId,
		});
	},
});
