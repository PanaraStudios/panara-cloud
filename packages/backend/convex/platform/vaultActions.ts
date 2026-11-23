import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type ActionCtx, action, internalAction } from "../_generated/server";
import { vaultProviderType } from "../tables/platform";
import { errorMessage } from "./lib/fetch";
import { mergeMaskedConfig, normalizeConfig } from "./lib/providerConfig";
import { encryptFields } from "./lib/secrets";
import {
	FETCH_VAULT_CLIENTS,
	findVaultReferences,
	isVaultProviderAssigned,
	NODE_VAULT_TYPES,
	VAULT_REF_REGEX,
	VAULT_SPECS,
	type VaultConfig,
	type VaultProviderType,
} from "./lib/vaultClients";
import { type VaultProviderWithCredentials, vaultAssignments } from "./vault";

const configInput = v.record(v.string(), v.string());

type Op = "getSecrets" | "testConnection" | "listSecretNames";

const callClient = async (
	ctx: ActionCtx,
	providerType: VaultProviderType,
	config: VaultConfig,
	op: Op,
	refs: string[] = [],
): Promise<{ values?: Record<string, string>; names?: string[] }> => {
	if (NODE_VAULT_TYPES.has(providerType)) {
		const result = await ctx.runAction(internal.platform.vaultNode.run, {
			providerType: providerType as "aws" | "aws-parameter-store",
			config,
			op,
			refs,
		});
		return {
			names: result.names,
			values: result.values
				? Object.fromEntries(result.values.map((e) => [e.ref, e.value]))
				: undefined,
		};
	}
	const client = FETCH_VAULT_CLIENTS[providerType];
	if (!client) throw new ConvexError(`Unsupported provider "${providerType}"`);
	try {
		if (op === "getSecrets") {
			return { values: await client.getSecrets(config, refs) };
		}
		if (op === "testConnection") {
			await client.testConnection(config);
			return {};
		}
		return { names: (await client.listSecretNames?.(config)) ?? [] };
	} catch (error) {
		throw new ConvexError(errorMessage(error));
	}
};

const fullConfig = (provider: {
	public: VaultConfig;
	secret: VaultConfig;
}) => ({
	...provider.public,
	...provider.secret,
});

export const create = action({
	args: {
		organizationId: v.string(),
		name: v.string(),
		providerType: vaultProviderType,
		config: configInput,
		assignments: vaultAssignments,
	},
	handler: async (ctx, args): Promise<Id<"vaultProviders">> => {
		await ctx.runQuery(internal.platform.vault.authorize, {
			organizationId: args.organizationId,
			action: "create",
		});
		const config = normalizeConfig(VAULT_SPECS[args.providerType], args.config);
		return await ctx.runMutation(internal.platform.vault.insert, {
			organizationId: args.organizationId,
			name: args.name.trim(),
			providerType: args.providerType,
			config: config.public,
			assignments: args.assignments,
			secret: await encryptFields(config.secret),
		});
	},
});

export const update = action({
	args: {
		vaultProviderId: v.id("vaultProviders"),
		name: v.string(),
		providerType: vaultProviderType,
		config: configInput,
		assignments: vaultAssignments,
	},
	handler: async (ctx, args): Promise<null> => {
		const existing = await ctx.runQuery(
			internal.platform.vault.getWithCredentials,
			{ vaultProviderId: args.vaultProviderId, action: "update" },
		);
		const config = mergeMaskedConfig(
			VAULT_SPECS[args.providerType],
			{ providerType: args.providerType, config: args.config },
			existing,
			true,
		);
		await ctx.runMutation(internal.platform.vault.patch, {
			vaultProviderId: args.vaultProviderId,
			name: args.name.trim(),
			providerType: args.providerType,
			config: config.public,
			assignments: args.assignments,
			secret: await encryptFields(config.secret),
		});
		return null;
	},
});

export const testConnection = action({
	args: {
		organizationId: v.string(),
		vaultProviderId: v.optional(v.id("vaultProviders")),
		providerType: v.optional(vaultProviderType),
		config: v.optional(configInput),
	},
	handler: async (ctx, args): Promise<true> => {
		let providerType = args.providerType;
		let config: VaultConfig;
		if (args.vaultProviderId) {
			const existing = await ctx.runQuery(
				internal.platform.vault.getWithCredentials,
				{ vaultProviderId: args.vaultProviderId, action: "create" },
			);
			if (existing.organizationId !== args.organizationId) {
				throw new ConvexError("Vault provider not found");
			}
			providerType ??= existing.providerType;
			config = args.config
				? fullConfig(
						mergeMaskedConfig(
							VAULT_SPECS[providerType],
							{ providerType, config: args.config },
							existing,
							true,
						),
					)
				: fullConfig(existing);
		} else {
			await ctx.runQuery(internal.platform.vault.authorize, {
				organizationId: args.organizationId,
				action: "create",
			});
			if (!providerType || !args.config) {
				throw new ConvexError("Provide a config or a vaultProviderId to test");
			}
			config = fullConfig(
				normalizeConfig(VAULT_SPECS[providerType], args.config),
			);
		}
		await callClient(ctx, providerType, config, "testConnection");
		return true;
	},
});

export const listSecretNames = action({
	args: {
		vaultProviderId: v.id("vaultProviders"),
		projectId: v.id("projects"),
		environmentId: v.optional(v.id("environments")),
	},
	handler: async (ctx, args): Promise<string[]> => {
		const provider = await ctx.runQuery(
			internal.platform.vault.getWithCredentials,
			{ vaultProviderId: args.vaultProviderId, action: "read" },
		);
		if (
			!isVaultProviderAssigned(
				provider.assignments,
				args.projectId,
				args.environmentId,
			)
		) {
			throw new ConvexError(
				"This vault provider is not enabled for the given project/environment",
			);
		}
		try {
			const { names } = await callClient(
				ctx,
				provider.providerType,
				fullConfig(provider),
				"listSecretNames",
			);
			return names ?? [];
		} catch {
			return [];
		}
	},
});

const providerNames = (values: string[]) => [
	...new Set(
		values.flatMap((value) =>
			findVaultReferences(value).map((match) => match.provider),
		),
	),
];

const refKey = (providerName: string, ref: string) => `${providerName} ${ref}`;

const resolveValues = async (
	ctx: ActionCtx,
	values: string[],
	providers: VaultProviderWithCredentials[],
	scope: { projectId: string; environmentId?: string },
): Promise<string[]> => {
	const refsByProvider = new Map<string, Set<string>>();
	for (const value of values) {
		for (const { provider, ref } of findVaultReferences(value)) {
			const refs = refsByProvider.get(provider) ?? new Set<string>();
			refs.add(ref);
			refsByProvider.set(provider, refs);
		}
	}
	if (refsByProvider.size === 0) return values;

	const resolved = new Map<string, string>();
	await Promise.all(
		[...refsByProvider.entries()].map(async ([providerName, refs]) => {
			const provider = providers.find((p) => p.name === providerName);
			if (!provider) {
				throw new ConvexError(
					`Vault provider "${providerName}" not found. Configure it in Settings -> Secrets Providers.`,
				);
			}
			if (
				!isVaultProviderAssigned(
					provider.assignments,
					scope.projectId,
					scope.environmentId,
				)
			) {
				throw new ConvexError(
					`Vault provider "${providerName}" is not enabled for this project/environment. Assign it in Settings -> Secrets Providers.`,
				);
			}
			const { values: secrets = {} } = await callClient(
				ctx,
				provider.providerType,
				fullConfig(provider),
				"getSecrets",
				[...refs],
			);
			for (const ref of refs) {
				const value = secrets[ref];
				if (value === undefined) {
					throw new ConvexError(
						`Secret "${ref}" not found in vault provider "${providerName}"`,
					);
				}
				resolved.set(refKey(providerName, ref), value);
			}
		}),
	);

	return values.map((value) =>
		value.replace(
			VAULT_REF_REGEX,
			(_, providerName: string, ref: string) =>
				resolved.get(refKey(providerName, ref)) ?? "",
		),
	);
};

const resolveArgs = {
	projectId: v.id("projects"),
	environmentId: v.optional(v.id("environments")),
	values: v.array(v.string()),
};

// For deploy code running in Convex: replaces every `${{vault.<provider>.<ref>}}`
// in `values` (env, build args, ...) and returns them in the same order.
export const resolveReferences = internalAction({
	args: { organizationId: v.string(), ...resolveArgs },
	handler: async (ctx, args): Promise<string[]> => {
		const names = providerNames(args.values);
		if (names.length === 0) return args.values;
		const providers = await ctx.runQuery(
			internal.platform.vault.loadForResolution,
			{ organizationId: args.organizationId, names },
		);
		return await resolveValues(ctx, args.values, providers, args);
	},
});

// For agents: same as resolveReferences, scoped to the organization of the
// job whose lease the caller holds.
export const resolveForJob = action({
	args: { jobId: v.id("jobs"), leaseId: v.string(), ...resolveArgs },
	handler: async (ctx, args): Promise<string[]> => {
		const names = providerNames(args.values);
		const { providers } = await ctx.runQuery(
			internal.platform.vault.loadForJob,
			{
				jobId: args.jobId,
				leaseId: args.leaseId,
				projectId: args.projectId,
				environmentId: args.environmentId,
				names,
			},
		);
		return await resolveValues(ctx, args.values, providers, args);
	},
});
