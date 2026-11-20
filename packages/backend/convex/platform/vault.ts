import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
	internalMutation,
	internalQuery,
	mutation,
	type QueryCtx,
	query,
} from "../_generated/server";
import { requireLease } from "../lib/lease";
import { requirePermission } from "../lib/permissions";
import { vaultProviderType } from "../tables/platform";
import { assertProviderName, maskConfig } from "./lib/providerConfig";
import { deleteSecret, readSecretFields, writeSecret } from "./lib/secrets";
import { VAULT_SPECS } from "./lib/vaultClients";

export const VAULT_SECRET_KIND = "platform.vaultProvider";
const MAX_PROVIDERS = 200;

export const vaultAssignments = v.array(
	v.object({
		projectId: v.id("projects"),
		environmentIds: v.array(v.id("environments")),
	}),
);

const vaultAction = v.union(
	v.literal("read"),
	v.literal("create"),
	v.literal("update"),
	v.literal("delete"),
);
const encrypted = v.object({ iv: v.string(), ciphertext: v.string() });

const toPublic = (provider: Doc<"vaultProviders">) => ({
	...provider,
	config: maskConfig(VAULT_SPECS[provider.providerType], provider.config),
});

const findByName = (ctx: QueryCtx, organizationId: string, name: string) =>
	ctx.db
		.query("vaultProviders")
		.withIndex("by_organizationId_and_name", (q) =>
			q.eq("organizationId", organizationId).eq("name", name),
		)
		.unique();

const assertNameAvailable = async (
	ctx: QueryCtx,
	organizationId: string,
	name: string,
	exceptId?: Id<"vaultProviders">,
) => {
	assertProviderName(name);
	const existing = await findByName(ctx, organizationId, name);
	if (existing && existing._id !== exceptId) {
		throw new ConvexError(
			`A vault provider named "${name}" already exists in this organization`,
		);
	}
};

const validateAssignments = async (
	ctx: QueryCtx,
	organizationId: string,
	assignments: typeof vaultAssignments.type,
) => {
	for (const assignment of assignments) {
		const project = await ctx.db.get("projects", assignment.projectId);
		if (!project || project.organizationId !== organizationId) {
			throw new ConvexError(
				"Assignment references a project outside this organization",
			);
		}
		for (const environmentId of assignment.environmentIds) {
			const environment = await ctx.db.get("environments", environmentId);
			if (!environment || environment.projectId !== project._id) {
				throw new ConvexError(
					"Assignment references an environment outside the selected project",
				);
			}
		}
	}
};

export const list = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requirePermission(ctx, organizationId, "vaultProvider", "read");
		const providers = await ctx.db
			.query("vaultProviders")
			.withIndex("by_organizationId_and_name", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_PROVIDERS);
		return providers.map(toPublic);
	},
});

export const get = query({
	args: { vaultProviderId: v.id("vaultProviders") },
	handler: async (ctx, { vaultProviderId }) => {
		const provider = await ctx.db.get("vaultProviders", vaultProviderId);
		if (!provider) return null;
		await requirePermission(
			ctx,
			provider.organizationId,
			"vaultProvider",
			"read",
		);
		return toPublic(provider);
	},
});

export const remove = mutation({
	args: { vaultProviderId: v.id("vaultProviders") },
	handler: async (ctx, { vaultProviderId }) => {
		const provider = await ctx.db.get("vaultProviders", vaultProviderId);
		if (!provider) return;
		await requirePermission(
			ctx,
			provider.organizationId,
			"vaultProvider",
			"delete",
		);
		await deleteSecret(ctx, VAULT_SECRET_KIND, vaultProviderId);
		await ctx.db.delete("vaultProviders", vaultProviderId);
	},
});

export const authorize = internalQuery({
	args: { organizationId: v.string(), action: vaultAction },
	handler: async (ctx, { organizationId, action }) => {
		await requirePermission(ctx, organizationId, "vaultProvider", action);
	},
});

export const insert = internalMutation({
	args: {
		organizationId: v.string(),
		name: v.string(),
		providerType: vaultProviderType,
		config: v.record(v.string(), v.string()),
		assignments: vaultAssignments,
		secret: encrypted,
	},
	handler: async (ctx, { secret, ...provider }) => {
		await requirePermission(
			ctx,
			provider.organizationId,
			"vaultProvider",
			"create",
		);
		await assertNameAvailable(ctx, provider.organizationId, provider.name);
		await validateAssignments(
			ctx,
			provider.organizationId,
			provider.assignments,
		);
		const vaultProviderId = await ctx.db.insert("vaultProviders", provider);
		await writeSecret(ctx, {
			organizationId: provider.organizationId,
			kind: VAULT_SECRET_KIND,
			ownerId: vaultProviderId,
			secret,
		});
		return vaultProviderId;
	},
});

export const patch = internalMutation({
	args: {
		vaultProviderId: v.id("vaultProviders"),
		name: v.string(),
		providerType: vaultProviderType,
		config: v.record(v.string(), v.string()),
		assignments: vaultAssignments,
		secret: encrypted,
	},
	handler: async (ctx, { vaultProviderId, secret, ...fields }) => {
		const provider = await ctx.db.get("vaultProviders", vaultProviderId);
		if (!provider) throw new ConvexError("Vault provider not found");
		await requirePermission(
			ctx,
			provider.organizationId,
			"vaultProvider",
			"update",
		);
		await assertNameAvailable(
			ctx,
			provider.organizationId,
			fields.name,
			vaultProviderId,
		);
		await validateAssignments(ctx, provider.organizationId, fields.assignments);
		await ctx.db.replace("vaultProviders", vaultProviderId, {
			organizationId: provider.organizationId,
			...fields,
		});
		await writeSecret(ctx, {
			organizationId: provider.organizationId,
			kind: VAULT_SECRET_KIND,
			ownerId: vaultProviderId,
			secret,
		});
	},
});

const withCredentials = async (
	ctx: QueryCtx,
	provider: Doc<"vaultProviders">,
) => ({
	_id: provider._id,
	name: provider.name,
	providerType: provider.providerType,
	assignments: provider.assignments,
	public: Object.fromEntries(
		Object.entries(provider.config).map(([k, value]) => [k, String(value)]),
	),
	secret: (await readSecretFields(ctx, VAULT_SECRET_KIND, provider._id)) ?? {},
});

export type VaultProviderWithCredentials = Awaited<
	ReturnType<typeof withCredentials>
>;

// For actions acting on behalf of the signed-in user (update, test, list names).
export const getWithCredentials = internalQuery({
	args: { vaultProviderId: v.id("vaultProviders"), action: vaultAction },
	handler: async (ctx, { vaultProviderId, action }) => {
		const provider = await ctx.db.get("vaultProviders", vaultProviderId);
		if (!provider) throw new ConvexError("Vault provider not found");
		await requirePermission(
			ctx,
			provider.organizationId,
			"vaultProvider",
			action,
		);
		return {
			organizationId: provider.organizationId,
			...(await withCredentials(ctx, provider)),
		};
	},
});

const providersByName = async (
	ctx: QueryCtx,
	organizationId: string,
	names: string[],
) => {
	const result: VaultProviderWithCredentials[] = [];
	for (const name of new Set(names)) {
		const provider = await findByName(ctx, organizationId, name);
		if (provider) result.push(await withCredentials(ctx, provider));
	}
	return result;
};

export const loadForResolution = internalQuery({
	args: { organizationId: v.string(), names: v.array(v.string()) },
	handler: async (ctx, { organizationId, names }) =>
		providersByName(ctx, organizationId, names),
});

// The job's organization bounds which providers an agent can read; the
// project must belong to it so a lease can't be used against another org.
export const loadForJob = internalQuery({
	args: {
		jobId: v.id("jobs"),
		leaseId: v.string(),
		projectId: v.id("projects"),
		environmentId: v.optional(v.id("environments")),
		names: v.array(v.string()),
	},
	handler: async (ctx, args) => {
		const { job } = await requireLease(ctx, args.jobId, args.leaseId);
		const project = await ctx.db.get("projects", args.projectId);
		if (!project || project.organizationId !== job.organizationId) {
			throw new ConvexError("Project not found");
		}
		if (args.environmentId) {
			const environment = await ctx.db.get("environments", args.environmentId);
			if (!environment || environment.projectId !== project._id) {
				throw new ConvexError("Environment not found");
			}
		}
		return {
			organizationId: job.organizationId,
			providers: await providersByName(ctx, job.organizationId, args.names),
		};
	},
});
