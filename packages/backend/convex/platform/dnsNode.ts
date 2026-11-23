"use node";

import {
	ChangeResourceRecordSetsCommand,
	ListHostedZonesCommand,
	ListResourceRecordSetsCommand,
	type ResourceRecordSet,
	Route53Client,
} from "@aws-sdk/client-route-53";
import { ConvexError, v } from "convex/values";
import { internalAction } from "../_generated/server";
import {
	type DnsClient,
	type DnsConfig,
	type DnsRecordInput,
	dnsRecordType,
} from "./lib/dnsClients";

const createClient = (config: DnsConfig) =>
	new Route53Client({
		region: "us-east-1",
		credentials: {
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
		},
	});

const stripTrailingDot = (name: string) => name.replace(/\.$/, "");
const ensureTrailingDot = (name: string) =>
	name.endsWith(".") ? name : `${name}.`;
const stripZonePrefix = (id: string) => id.replace(/^\/hostedzone\//, "");

// Route53 returns special characters as \ + octal (e.g. * as \052). Escaped
// dots (\056) and backslashes (\134) stay escaped so names remain unique.
const decodeRecordName = (name: string) =>
	name.replace(/\\([0-7]{3})/g, (match, code: string) =>
		code === "056" || code === "134"
			? match
			: String.fromCharCode(Number.parseInt(code, 8)),
	);

const buildRecordId = (type: string, name: string) =>
	`${type}:${stripTrailingDot(name)}`;

const parseRecordId = (id: string) => {
	const separatorIndex = id.indexOf(":");
	if (separatorIndex === -1)
		throw new ConvexError(`Invalid Route53 record id: "${id}"`);
	return {
		type: id.slice(0, separatorIndex),
		name: id.slice(separatorIndex + 1),
	};
};

const findExactRecordSet = async (
	config: DnsConfig,
	zoneId: string,
	type: string,
	name: string,
): Promise<ResourceRecordSet | undefined> => {
	const response = await createClient(config).send(
		new ListResourceRecordSetsCommand({
			HostedZoneId: zoneId,
			StartRecordName: ensureTrailingDot(name),
			StartRecordType: type as ResourceRecordSet["Type"],
			MaxItems: 1,
		}),
	);
	const candidate = response.ResourceRecordSets?.[0];
	if (
		candidate &&
		candidate.Type === type &&
		stripTrailingDot(decodeRecordName(candidate.Name ?? "")) ===
			stripTrailingDot(name)
	) {
		return candidate;
	}
	return undefined;
};

const formatValue = (type: string, value: string) =>
	type === "TXT" && !value.startsWith('"') ? JSON.stringify(value) : value;

const buildRecordSet = (
	record: Omit<DnsRecordInput, "zoneId">,
): ResourceRecordSet => ({
	Name: ensureTrailingDot(record.name),
	Type: record.type as ResourceRecordSet["Type"],
	TTL: record.ttl ?? 300,
	ResourceRecords: record.content
		.split("\n")
		.map((value) => value.trim())
		.filter(Boolean)
		.map((value) => ({ Value: formatValue(record.type, value) })),
});

const route53Client: DnsClient = {
	async listZones(config) {
		const client = createClient(config);
		const zones: { id: string; name: string }[] = [];
		let marker: string | undefined;
		do {
			const response = await client.send(
				new ListHostedZonesCommand({ Marker: marker, MaxItems: 100 }),
			);
			for (const zone of response.HostedZones ?? []) {
				if (zone.Id && zone.Name) {
					zones.push({
						id: stripZonePrefix(zone.Id),
						name: stripTrailingDot(zone.Name),
					});
				}
			}
			marker = response.IsTruncated ? response.NextMarker : undefined;
		} while (marker);
		return zones;
	},

	async listRecords(config, zoneId) {
		const client = createClient(config);
		const records: {
			id: string;
			type: string;
			name: string;
			content: string;
			ttl: number;
		}[] = [];
		let nextName: string | undefined;
		let nextType: string | undefined;
		do {
			const response = await client.send(
				new ListResourceRecordSetsCommand({
					HostedZoneId: zoneId,
					StartRecordName: nextName,
					StartRecordType: nextType as ResourceRecordSet["Type"] | undefined,
				}),
			);
			for (const set of response.ResourceRecordSets ?? []) {
				if (!set.Name || !set.Type || !set.ResourceRecords?.length) continue;
				const name = decodeRecordName(set.Name);
				records.push({
					id: buildRecordId(set.Type, name),
					type: set.Type,
					name: stripTrailingDot(name),
					content: set.ResourceRecords.map((r) => r.Value).join("\n"),
					ttl: set.TTL ?? 300,
				});
			}
			nextName = response.IsTruncated ? response.NextRecordName : undefined;
			nextType = response.IsTruncated ? response.NextRecordType : undefined;
		} while (nextName);
		return records;
	},

	async upsertRecord(config, record) {
		const existing = await findExactRecordSet(
			config,
			record.zoneId,
			record.type,
			record.name,
		);
		const recordSet = buildRecordSet(record);
		if (existing?.ResourceRecords?.length) {
			const values = new Set([
				...existing.ResourceRecords.map((r) => r.Value),
				...(recordSet.ResourceRecords ?? []).map((r) => r.Value),
			]);
			recordSet.ResourceRecords = [...values].map((Value) => ({ Value }));
		}
		await createClient(config).send(
			new ChangeResourceRecordSetsCommand({
				HostedZoneId: record.zoneId,
				ChangeBatch: {
					Changes: [{ Action: "UPSERT", ResourceRecordSet: recordSet }],
				},
			}),
		);
		return { id: buildRecordId(record.type, record.name) };
	},

	async updateRecord(config, zoneId, recordId, record) {
		const { type: oldType, name: oldName } = parseRecordId(recordId);
		const changes: {
			Action: "DELETE" | "UPSERT";
			ResourceRecordSet: ResourceRecordSet;
		}[] = [];
		const sameIdentity =
			oldType === record.type &&
			stripTrailingDot(oldName) === stripTrailingDot(record.name);
		if (!sameIdentity) {
			const existing = await findExactRecordSet(
				config,
				zoneId,
				oldType,
				oldName,
			);
			if (existing)
				changes.push({ Action: "DELETE", ResourceRecordSet: existing });
		}
		changes.push({
			Action: "UPSERT",
			ResourceRecordSet: buildRecordSet(record),
		});
		await createClient(config).send(
			new ChangeResourceRecordSetsCommand({
				HostedZoneId: zoneId,
				ChangeBatch: { Changes: changes },
			}),
		);
		return { id: buildRecordId(record.type, record.name) };
	},

	async deleteRecord(config, zoneId, recordId) {
		const { type, name } = parseRecordId(recordId);
		const existing = await findExactRecordSet(config, zoneId, type, name);
		if (!existing)
			throw new ConvexError(`Route53: record "${name}" (${type}) not found`);
		await createClient(config).send(
			new ChangeResourceRecordSetsCommand({
				HostedZoneId: zoneId,
				ChangeBatch: {
					Changes: [{ Action: "DELETE", ResourceRecordSet: existing }],
				},
			}),
		);
	},

	async testConnection(config) {
		await createClient(config).send(
			new ListHostedZonesCommand({ MaxItems: 1 }),
		);
	},
};

const recordFields = {
	type: dnsRecordType,
	name: v.string(),
	content: v.string(),
	ttl: v.optional(v.number()),
	proxied: v.optional(v.boolean()),
};

export const run = internalAction({
	args: {
		config: v.record(v.string(), v.string()),
		op: v.union(
			v.object({ kind: v.literal("listZones") }),
			v.object({ kind: v.literal("listRecords"), zoneId: v.string() }),
			v.object({
				kind: v.literal("upsertRecord"),
				record: v.object({ zoneId: v.string(), ...recordFields }),
			}),
			v.object({
				kind: v.literal("updateRecord"),
				zoneId: v.string(),
				recordId: v.string(),
				record: v.object(recordFields),
			}),
			v.object({
				kind: v.literal("deleteRecord"),
				zoneId: v.string(),
				recordId: v.string(),
			}),
			v.object({ kind: v.literal("testConnection") }),
		),
	},
	handler: async (_ctx, { config, op }): Promise<unknown> => {
		try {
			switch (op.kind) {
				case "listZones":
					return await route53Client.listZones(config);
				case "listRecords":
					return await route53Client.listRecords(config, op.zoneId);
				case "upsertRecord":
					return await route53Client.upsertRecord(config, op.record);
				case "updateRecord":
					return await route53Client.updateRecord(
						config,
						op.zoneId,
						op.recordId,
						op.record,
					);
				case "deleteRecord":
					await route53Client.deleteRecord(config, op.zoneId, op.recordId);
					return null;
				case "testConnection":
					await route53Client.testConnection(config);
					return null;
			}
		} catch (error) {
			throw new ConvexError(
				error instanceof Error ? error.message : String(error),
			);
		}
	},
});
