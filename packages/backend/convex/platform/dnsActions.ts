import type { FunctionArgs } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type ActionCtx, action, internalAction } from "../_generated/server";
import { dnsProviderType } from "../tables/platform";
import {
	DNS_SPECS,
	type DnsClient,
	type DnsConfig,
	type DnsProviderType,
	type DnsRecord,
	type DnsZone,
	dnsRecordType,
	FETCH_DNS_CLIENTS,
	NODE_DNS_TYPES,
} from "./lib/dnsClients";
import { errorMessage } from "./lib/fetch";
import { mergeMaskedConfig, normalizeConfig } from "./lib/providerConfig";
import { encryptFields } from "./lib/secrets";

const configInput = v.record(v.string(), v.string());

const recordFields = {
	type: dnsRecordType,
	name: v.string(),
	content: v.string(),
	ttl: v.optional(v.number()),
	proxied: v.optional(v.boolean()),
};

type NodeOp = FunctionArgs<typeof internal.platform.dnsNode.run>["op"];

const nodeClient = (ctx: ActionCtx): DnsClient => {
	const run = (config: DnsConfig, op: NodeOp) =>
		ctx.runAction(internal.platform.dnsNode.run, { config, op });
	return {
		listZones: async (config) =>
			(await run(config, { kind: "listZones" })) as DnsZone[],
		listRecords: async (config, zoneId) =>
			(await run(config, { kind: "listRecords", zoneId })) as DnsRecord[],
		upsertRecord: async (config, record) =>
			(await run(config, { kind: "upsertRecord", record })) as { id: string },
		updateRecord: async (config, zoneId, recordId, record) =>
			(await run(config, {
				kind: "updateRecord",
				zoneId,
				recordId,
				record,
			})) as { id: string },
		deleteRecord: async (config, zoneId, recordId) => {
			await run(config, { kind: "deleteRecord", zoneId, recordId });
		},
		testConnection: async (config) => {
			await run(config, { kind: "testConnection" });
		},
	};
};

// Wraps every call so provider errors reach the client as readable messages.
const clientFor = (
	ctx: ActionCtx,
	providerType: DnsProviderType,
): DnsClient => {
	const client = NODE_DNS_TYPES.has(providerType)
		? nodeClient(ctx)
		: FETCH_DNS_CLIENTS[providerType];
	if (!client) throw new ConvexError(`Unsupported provider "${providerType}"`);
	return new Proxy(client, {
		get(target, key: keyof DnsClient) {
			const method = target[key] as (...args: unknown[]) => Promise<unknown>;
			return async (...args: unknown[]) => {
				try {
					return await method.apply(target, args);
				} catch (error) {
					if (error instanceof ConvexError) throw error;
					throw new ConvexError(errorMessage(error));
				}
			};
		},
	});
};

type LoadedProvider = {
	providerType: DnsProviderType;
	public: DnsConfig;
	secret: DnsConfig;
};

const configOf = (provider: LoadedProvider): DnsConfig => ({
	...provider.public,
	...provider.secret,
});

const load = (
	ctx: ActionCtx,
	dnsProviderId: Id<"dnsProviders">,
	action: "read" | "create" | "update" | "delete",
): Promise<LoadedProvider & { organizationId: string }> =>
	ctx.runQuery(internal.platform.dns.getWithCredentials, {
		dnsProviderId,
		action,
	});

export const create = action({
	args: {
		organizationId: v.string(),
		name: v.string(),
		providerType: dnsProviderType,
		config: configInput,
	},
	handler: async (ctx, args): Promise<Id<"dnsProviders">> => {
		await ctx.runQuery(internal.platform.dns.authorize, {
			organizationId: args.organizationId,
			action: "create",
		});
		const config = normalizeConfig(DNS_SPECS[args.providerType], args.config);
		return await ctx.runMutation(internal.platform.dns.insert, {
			organizationId: args.organizationId,
			name: args.name.trim(),
			providerType: args.providerType,
			config: config.public,
			secret: await encryptFields(config.secret),
		});
	},
});

export const update = action({
	args: {
		dnsProviderId: v.id("dnsProviders"),
		name: v.string(),
		providerType: dnsProviderType,
		config: configInput,
	},
	handler: async (ctx, args): Promise<null> => {
		const existing = await load(ctx, args.dnsProviderId, "update");
		const config = mergeMaskedConfig(
			DNS_SPECS[args.providerType],
			{ providerType: args.providerType, config: args.config },
			existing,
			false,
		);
		await ctx.runMutation(internal.platform.dns.patch, {
			dnsProviderId: args.dnsProviderId,
			name: args.name.trim(),
			providerType: args.providerType,
			config: config.public,
			secret: await encryptFields(config.secret),
		});
		return null;
	},
});

export const testConnection = action({
	args: {
		organizationId: v.string(),
		dnsProviderId: v.optional(v.id("dnsProviders")),
		providerType: v.optional(dnsProviderType),
		config: v.optional(configInput),
	},
	handler: async (ctx, args): Promise<true> => {
		let providerType = args.providerType;
		let config: DnsConfig;
		if (args.dnsProviderId) {
			const existing = await load(ctx, args.dnsProviderId, "create");
			if (existing.organizationId !== args.organizationId) {
				throw new ConvexError("DNS provider not found");
			}
			providerType ??= existing.providerType;
			config = args.config
				? configOf({
						providerType,
						...mergeMaskedConfig(
							DNS_SPECS[providerType],
							{ providerType, config: args.config },
							existing,
							false,
						),
					})
				: configOf(existing);
		} else {
			await ctx.runQuery(internal.platform.dns.authorize, {
				organizationId: args.organizationId,
				action: "create",
			});
			if (!providerType || !args.config) {
				throw new ConvexError("Provide a config or a dnsProviderId to test");
			}
			config = configOf({
				providerType,
				...normalizeConfig(DNS_SPECS[providerType], args.config),
			});
		}
		await clientFor(ctx, providerType).testConnection(config);
		return true;
	},
});

export const listZones = action({
	args: { dnsProviderId: v.id("dnsProviders") },
	handler: async (ctx, { dnsProviderId }): Promise<DnsZone[]> => {
		const provider = await load(ctx, dnsProviderId, "read");
		return await clientFor(ctx, provider.providerType).listZones(
			configOf(provider),
		);
	},
});

export const listRecords = action({
	args: { dnsProviderId: v.id("dnsProviders"), zoneId: v.string() },
	handler: async (ctx, { dnsProviderId, zoneId }): Promise<DnsRecord[]> => {
		const provider = await load(ctx, dnsProviderId, "read");
		return await clientFor(ctx, provider.providerType).listRecords(
			configOf(provider),
			zoneId,
		);
	},
});

export const createRecord = action({
	args: {
		dnsProviderId: v.id("dnsProviders"),
		zoneId: v.string(),
		...recordFields,
	},
	handler: async (
		ctx,
		{ dnsProviderId, ...record },
	): Promise<{ id: string }> => {
		const provider = await load(ctx, dnsProviderId, "update");
		return await clientFor(ctx, provider.providerType).upsertRecord(
			configOf(provider),
			record,
		);
	},
});

export const updateRecord = action({
	args: {
		dnsProviderId: v.id("dnsProviders"),
		zoneId: v.string(),
		recordId: v.string(),
		...recordFields,
	},
	handler: async (
		ctx,
		{ dnsProviderId, zoneId, recordId, ...record },
	): Promise<{ id: string }> => {
		const provider = await load(ctx, dnsProviderId, "update");
		return await clientFor(ctx, provider.providerType).updateRecord(
			configOf(provider),
			zoneId,
			recordId,
			record,
		);
	},
});

export const deleteRecord = action({
	args: {
		dnsProviderId: v.id("dnsProviders"),
		zoneId: v.string(),
		recordId: v.string(),
	},
	handler: async (ctx, { dnsProviderId, zoneId, recordId }): Promise<true> => {
		const provider = await load(ctx, dnsProviderId, "delete");
		await clientFor(ctx, provider.providerType).deleteRecord(
			configOf(provider),
			zoneId,
			recordId,
		);
		return true;
	},
});

const normalizeName = (name: string) =>
	name.trim().replace(/\.$/, "").toLowerCase();

const resolveZone = async (
	client: DnsClient,
	config: DnsConfig,
	args: { zoneId?: string; zoneName?: string; name: string },
): Promise<string> => {
	if (args.zoneId) return args.zoneId;
	const zones = await client.listZones(config);
	if (args.zoneName) {
		const wanted = normalizeName(args.zoneName);
		const zone = zones.find((z) => normalizeName(z.name) === wanted);
		if (!zone) throw new ConvexError(`DNS zone "${args.zoneName}" not found`);
		return zone.id;
	}
	const host = normalizeName(args.name);
	const zone = zones
		.filter((z) => {
			const zoneName = normalizeName(z.name);
			return host === zoneName || host.endsWith(`.${zoneName}`);
		})
		.sort((a, b) => b.name.length - a.name.length)[0];
	if (!zone) throw new ConvexError(`No DNS zone found for "${args.name}"`);
	return zone.id;
};

const sameRecord = (record: DnsRecord, type: string, name: string) =>
	record.type === type && normalizeName(record.name) === normalizeName(name);

const loadForOrganization = (
	ctx: ActionCtx,
	organizationId: string,
	dnsProviderId: Id<"dnsProviders">,
): Promise<LoadedProvider> =>
	ctx.runQuery(internal.platform.dns.loadForOrganization, {
		organizationId,
		dnsProviderId,
	});

const zoneArgs = {
	zoneId: v.optional(v.string()),
	zoneName: v.optional(v.string()),
};

// For routing/domains code. The zone comes from `zoneId`, `zoneName`, or the
// longest zone that is a suffix of `name`. An identical record is updated in
// place; with `replace`, an existing record of the same name and type is
// overwritten instead of adding a second value.
export const upsertRecord = internalAction({
	args: {
		organizationId: v.string(),
		dnsProviderId: v.id("dnsProviders"),
		...zoneArgs,
		...recordFields,
		replace: v.optional(v.boolean()),
	},
	handler: async (
		ctx,
		{ organizationId, dnsProviderId, zoneId, zoneName, replace, ...record },
	): Promise<{ id: string; zoneId: string }> => {
		const provider = await loadForOrganization(
			ctx,
			organizationId,
			dnsProviderId,
		);
		const client = clientFor(ctx, provider.providerType);
		const config = configOf(provider);
		const resolvedZoneId = await resolveZone(client, config, {
			zoneId,
			zoneName,
			name: record.name,
		});
		if (replace) {
			const existing = (await client.listRecords(config, resolvedZoneId)).find(
				(r) => sameRecord(r, record.type, record.name),
			);
			if (existing) {
				if (existing.content === record.content.trim()) {
					return { id: existing.id, zoneId: resolvedZoneId };
				}
				const updated = await client.updateRecord(
					config,
					resolvedZoneId,
					existing.id,
					record,
				);
				return { id: updated.id, zoneId: resolvedZoneId };
			}
		}
		const result = await client.upsertRecord(config, {
			zoneId: resolvedZoneId,
			...record,
		});
		return { id: result.id, zoneId: resolvedZoneId };
	},
});

// Deletes by `recordId`, or every record matching `type` + `name` (and
// `content`, when given). Returns how many records were removed.
export const removeRecord = internalAction({
	args: {
		organizationId: v.string(),
		dnsProviderId: v.id("dnsProviders"),
		...zoneArgs,
		recordId: v.optional(v.string()),
		type: v.optional(dnsRecordType),
		name: v.string(),
		content: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<number> => {
		const provider = await loadForOrganization(
			ctx,
			args.organizationId,
			args.dnsProviderId,
		);
		const client = clientFor(ctx, provider.providerType);
		const config = configOf(provider);
		const zoneId = await resolveZone(client, config, args);
		if (args.recordId) {
			await client.deleteRecord(config, zoneId, args.recordId);
			return 1;
		}
		if (!args.type) throw new ConvexError("Provide a recordId or a type");
		const type = args.type;
		const matches = (await client.listRecords(config, zoneId)).filter(
			(r) =>
				sameRecord(r, type, args.name) &&
				(args.content === undefined || r.content === args.content.trim()),
		);
		for (const record of matches) {
			await client.deleteRecord(config, zoneId, record.id);
		}
		return matches.length;
	},
});
