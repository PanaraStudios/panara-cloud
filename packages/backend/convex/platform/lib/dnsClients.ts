import { ConvexError, type Infer, v } from "convex/values";
import type { dnsProviderType } from "../../tables/platform";
import { providerFetch } from "./fetch";
import type { ProviderSpec } from "./providerConfig";

export type DnsProviderType = Infer<typeof dnsProviderType>;
export type DnsConfig = Record<string, string>;

export const dnsRecordType = v.union(
	v.literal("A"),
	v.literal("AAAA"),
	v.literal("CNAME"),
	v.literal("MX"),
	v.literal("TXT"),
	v.literal("NS"),
	v.literal("SRV"),
	v.literal("CAA"),
	v.literal("PTR"),
);
export type DnsRecordType = Infer<typeof dnsRecordType>;

export const PROXIABLE_RECORD_TYPES = ["A", "AAAA", "CNAME"] as const;

export interface DnsZone {
	id: string;
	name: string;
}

export interface DnsRecordInput {
	zoneId: string;
	type: DnsRecordType;
	name: string;
	content: string;
	ttl?: number;
	proxied?: boolean;
}

export interface DnsRecord {
	id: string;
	type: string;
	name: string;
	content: string;
	ttl: number;
	proxied?: boolean;
}

export interface DnsClient {
	listZones(config: DnsConfig): Promise<DnsZone[]>;
	listRecords(config: DnsConfig, zoneId: string): Promise<DnsRecord[]>;
	upsertRecord(
		config: DnsConfig,
		record: DnsRecordInput,
	): Promise<{ id: string }>;
	updateRecord(
		config: DnsConfig,
		zoneId: string,
		recordId: string,
		record: Omit<DnsRecordInput, "zoneId">,
	): Promise<{ id: string }>;
	deleteRecord(
		config: DnsConfig,
		zoneId: string,
		recordId: string,
	): Promise<void>;
	testConnection(config: DnsConfig): Promise<void>;
}

export const OVH_ENDPOINTS: Record<string, string> = {
	"ovh-eu": "https://eu.api.ovh.com/1.0",
	"ovh-ca": "https://ca.api.ovh.com/1.0",
	"ovh-us": "https://api.us.ovhcloud.com/1.0",
	"kimsufi-eu": "https://eu.api.kimsufi.com/1.0",
	"kimsufi-ca": "https://ca.api.kimsufi.com/1.0",
	"soyoustart-eu": "https://eu.api.soyoustart.com/1.0",
	"soyoustart-ca": "https://ca.api.soyoustart.com/1.0",
};

const secret = { required: true, secret: true } as const;

export const DNS_SPECS: Record<DnsProviderType, ProviderSpec> = {
	cloudflare: { apiToken: secret },
	route53: { accessKeyId: secret, secretAccessKey: secret },
	porkbun: { apiKey: secret, secretApiKey: secret },
	infomaniak: { apiToken: secret },
	ovh: {
		endpoint: { default: "ovh-eu", oneOf: Object.keys(OVH_ENDPOINTS) },
		applicationKey: { required: true },
		applicationSecret: secret,
		consumerKey: secret,
		zone: {},
	},
};

// Route53 uses the AWS SDK and lives in ../dnsNode.ts.
export const NODE_DNS_TYPES = new Set<DnsProviderType>(["route53"]);

const readJson = async (response: Response): Promise<unknown> => {
	const text = await response.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

type CloudflareRecord = {
	id: string;
	type: string;
	name: string;
	content: string;
	ttl: number;
	priority?: number;
	proxied?: boolean;
	data?: Record<string, unknown>;
};

const cfInlinePriority = (record: {
	type: string;
	content: string;
	priority?: number;
}) =>
	record.type === "MX" && typeof record.priority === "number"
		? `${record.priority} ${record.content}`
		: record.content;

const cfProxySettings = (record: { type: string; proxied?: boolean }) =>
	record.proxied !== undefined &&
	(PROXIABLE_RECORD_TYPES as readonly string[]).includes(record.type)
		? { proxied: record.proxied }
		: {};

const cfBuildValue = (record: {
	type: string;
	content: string;
}): {
	content?: string;
	priority?: number;
	data?: Record<string, string | number>;
} => {
	const value = record.content.trim();
	if (record.type === "MX") {
		const match = /^(\d+)\s+(\S.*)$/.exec(value);
		return match
			? { content: match[2] as string, priority: Number(match[1]) }
			: { content: value, priority: 10 };
	}
	if (record.type === "SRV") {
		const parts = value.split(/\s+/);
		const [priority, weight, port, target] = parts;
		if (parts.length !== 4 || !target) {
			throw new ConvexError(
				`Cloudflare: an SRV value must be "priority weight port target", got "${value}"`,
			);
		}
		return {
			data: {
				priority: Number(priority),
				weight: Number(weight),
				port: Number(port),
				target,
			},
		};
	}
	if (record.type === "CAA") {
		const match = /^(\d+)\s+(\S+)\s+"?([^"]+)"?$/.exec(value);
		if (!match) {
			throw new ConvexError(
				`Cloudflare: a CAA value must be \`flags tag "value"\`, got "${value}"`,
			);
		}
		return {
			data: {
				flags: Number(match[1]),
				tag: match[2] as string,
				value: match[3] as string,
			},
		};
	}
	return { content: value };
};

const cfFetch = async <T>(
	config: DnsConfig,
	path: string,
	init: RequestInit = {},
): Promise<T> => {
	const response = await providerFetch(`${CLOUDFLARE_API}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${config.apiToken.trim()}`,
			"Content-Type": "application/json",
			...init.headers,
		},
	});
	const body = (await readJson(response)) as {
		success?: boolean;
		errors?: { message: string }[];
		result: T;
	} | null;
	if (!response.ok || !body?.success) {
		const detail = body?.errors?.map((e) => e.message).join(", ");
		throw new ConvexError(
			`Cloudflare: request to ${path} failed${detail ? `: ${detail}` : ` (status ${response.status})`}`,
		);
	}
	return body.result;
};

const cfRecordPayload = (record: Omit<DnsRecordInput, "zoneId">) => ({
	type: record.type,
	name: record.name,
	...cfBuildValue(record),
	...cfProxySettings(record),
	ttl: record.ttl ?? 1,
});

const cloudflareClient: DnsClient = {
	async listZones(config) {
		const zones: DnsZone[] = [];
		for (let page = 1; ; page++) {
			const result = await cfFetch<DnsZone[]>(
				config,
				`/zones?per_page=50&page=${page}`,
			);
			zones.push(...result.map((zone) => ({ id: zone.id, name: zone.name })));
			if (result.length < 50) return zones;
		}
	},

	async listRecords(config, zoneId) {
		const records: DnsRecord[] = [];
		for (let page = 1; ; page++) {
			const result = await cfFetch<CloudflareRecord[]>(
				config,
				`/zones/${zoneId}/dns_records?per_page=50&page=${page}`,
			);
			records.push(
				...result.map((record) => ({
					id: record.id,
					type: record.type,
					name: record.name,
					content: cfInlinePriority(record),
					ttl: record.ttl,
					proxied: record.proxied,
				})),
			);
			if (result.length < 50) return records;
		}
	},

	async upsertRecord(config, record) {
		const payload = cfRecordPayload(record);
		const existing = await cfFetch<CloudflareRecord[]>(
			config,
			`/zones/${record.zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}`,
		);
		const built = cfBuildValue(record);
		const match = existing.find((candidate) => {
			if (built.data) {
				return Object.entries(built.data).every(
					([key, value]) => candidate.data && candidate.data[key] === value,
				);
			}
			return (
				cfInlinePriority(candidate) ===
				cfInlinePriority({
					type: record.type,
					content: built.content ?? record.content.trim(),
					priority: built.priority,
				})
			);
		});
		if (match) {
			const updated = await cfFetch<{ id: string }>(
				config,
				`/zones/${record.zoneId}/dns_records/${match.id}`,
				{ method: "PUT", body: JSON.stringify(payload) },
			);
			return { id: updated.id };
		}
		const created = await cfFetch<{ id: string }>(
			config,
			`/zones/${record.zoneId}/dns_records`,
			{ method: "POST", body: JSON.stringify(payload) },
		);
		return { id: created.id };
	},

	async updateRecord(config, zoneId, recordId, record) {
		const updated = await cfFetch<{ id: string }>(
			config,
			`/zones/${zoneId}/dns_records/${recordId}`,
			{ method: "PUT", body: JSON.stringify(cfRecordPayload(record)) },
		);
		return { id: updated.id };
	},

	async deleteRecord(config, zoneId, recordId) {
		await cfFetch(config, `/zones/${zoneId}/dns_records/${recordId}`, {
			method: "DELETE",
		});
	},

	async testConnection(config) {
		await cfFetch(config, "/zones?per_page=1");
	},
};

const PORKBUN_API = "https://api.porkbun.com/api/json/v3";

type PorkbunRecord = {
	id: string;
	name: string;
	type: string;
	content: string;
	ttl: string;
	prio?: string | null;
};

const pbFetch = async <T>(
	config: DnsConfig,
	path: string,
	body: Record<string, unknown> = {},
): Promise<T> => {
	const response = await providerFetch(`${PORKBUN_API}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			apikey: config.apiKey,
			secretapikey: config.secretApiKey,
			...body,
		}),
	});
	const result = (await readJson(response)) as
		| (T & { status?: string; message?: string })
		| null;
	if (!response.ok || result?.status !== "SUCCESS") {
		throw new ConvexError(
			`Porkbun: request to ${path} failed${
				result?.message ? `: ${result.message}` : ` (status ${response.status})`
			}`,
		);
	}
	return result;
};

// Porkbun's "name" is the subdomain only, without the zone.
const pbSubdomain = (name: string, domain: string) => {
	if (name === domain) return "";
	const suffix = `.${domain}`;
	return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
};

const pbInlinePriority = (record: {
	type: string;
	content: string;
	prio?: string | null;
}) =>
	(record.type === "MX" || record.type === "SRV") && record.prio != null
		? `${record.prio} ${record.content}`
		: record.content;

const pbBuildValue = (record: { type: string; content: string }) => {
	const value = record.content.trim();
	if (record.type === "MX" || record.type === "SRV") {
		const match = /^(\d+)\s+(\S.*)$/.exec(value);
		if (match) return { content: match[2] as string, prio: match[1] as string };
	}
	return { content: value, prio: undefined };
};

const pbPayload = (record: Omit<DnsRecordInput, "zoneId">, zone: string) => {
	const built = pbBuildValue(record);
	return {
		name: pbSubdomain(record.name, zone),
		type: record.type,
		content: built.content,
		...(built.prio ? { prio: built.prio } : {}),
		ttl: record.ttl ?? 600,
	};
};

const porkbunClient: DnsClient = {
	async listZones(config) {
		const result = await pbFetch<{ domains: { domain: string }[] }>(
			config,
			"/domain/listAll",
		);
		return result.domains.map((d) => ({ id: d.domain, name: d.domain }));
	},

	async listRecords(config, zoneId) {
		const result = await pbFetch<{ records: PorkbunRecord[] }>(
			config,
			`/dns/retrieve/${zoneId}`,
		);
		return result.records.map((record) => ({
			id: record.id,
			type: record.type,
			name: record.name,
			content: pbInlinePriority(record),
			ttl: Number(record.ttl),
		}));
	},

	async upsertRecord(config, record) {
		const payload = pbPayload(record, record.zoneId);
		const existing = await pbFetch<{ records: PorkbunRecord[] }>(
			config,
			`/dns/retrieveByNameType/${record.zoneId}/${record.type}/${payload.name}`,
		);
		const built = pbBuildValue(record);
		const expected = pbInlinePriority({
			type: record.type,
			content: built.content,
			prio: built.prio,
		});
		const match = existing.records.find(
			(candidate) => pbInlinePriority(candidate) === expected,
		);
		if (match) {
			await pbFetch(config, `/dns/edit/${record.zoneId}/${match.id}`, payload);
			return { id: match.id };
		}
		const created = await pbFetch<{ id: string | number }>(
			config,
			`/dns/create/${record.zoneId}`,
			payload,
		);
		return { id: String(created.id) };
	},

	async updateRecord(config, zoneId, recordId, record) {
		await pbFetch(
			config,
			`/dns/edit/${zoneId}/${recordId}`,
			pbPayload(record, zoneId),
		);
		return { id: recordId };
	},

	async deleteRecord(config, zoneId, recordId) {
		await pbFetch(config, `/dns/delete/${zoneId}/${recordId}`);
	},

	async testConnection(config) {
		await pbFetch(config, "/ping");
	},
};

const INFOMANIAK_API = "https://api.infomaniak.com";
// Infomaniak requires a TTL on every record, within 60..86400.
const INFOMANIAK_DEFAULT_TTL = 300;
const INFOMANIAK_PRODUCTS_PER_PAGE = 100;

type InfomaniakRecord = {
	id: number | string;
	type: string;
	source: string;
	target: string;
	ttl: number;
};

type InfomaniakResponse<T> = {
	result?: string;
	data?: T;
	error?: { code?: string; description?: string };
	pages?: number;
};

const ikRequest = async <T>(
	config: DnsConfig,
	path: string,
	init: RequestInit = {},
): Promise<InfomaniakResponse<T>> => {
	const response = await providerFetch(`${INFOMANIAK_API}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${config.apiToken.trim()}`,
			"Content-Type": "application/json",
			...init.headers,
		},
	});
	const body = (await readJson(response)) as InfomaniakResponse<T> | null;
	if (!response.ok || body?.result !== "success") {
		const detail = body?.error?.description ?? body?.error?.code;
		throw new ConvexError(
			`Infomaniak: request to ${path} failed${
				detail ? `: ${detail}` : ` (status ${response.status})`
			}`,
		);
	}
	return body;
};

const ikFetch = async <T>(
	config: DnsConfig,
	path: string,
	init: RequestInit = {},
): Promise<T> => (await ikRequest<T>(config, path, init)).data as T;

// "source" is relative to the zone; the apex is written as "." but "" and "@"
// are accepted when reading so hand-written records still match.
const IK_APEX_SOURCES = new Set(["", ".", "@"]);

const ikSource = (name: string, zone: string) => {
	const fqdn = name.replace(/\.$/, "");
	if (fqdn === zone) return ".";
	const suffix = `.${zone}`;
	return fqdn.endsWith(suffix) ? fqdn.slice(0, -suffix.length) : fqdn;
};

const ikFqdn = (source: string, zone: string) =>
	IK_APEX_SOURCES.has(source) ? zone : `${source}.${zone}`;

const ikNormalizeSource = (source: string) =>
	IK_APEX_SOURCES.has(source) ? "." : source;

// TXT targets are stored quoted; keep them unquoted here so edits don't stack quotes.
const ikUnquote = (target: string) => {
	if (target.length >= 2 && target.startsWith('"') && target.endsWith('"')) {
		try {
			const unquoted: unknown = JSON.parse(target);
			if (typeof unquoted === "string") return unquoted;
		} catch {
			return target;
		}
	}
	return target;
};

const ikQuote = (type: string, content: string) => {
	const value = content.trim();
	if (type !== "TXT") return value;
	return value.startsWith('"') && value.endsWith('"')
		? value
		: JSON.stringify(value);
};

const ikPayload = (record: Omit<DnsRecordInput, "zoneId">, zone: string) => ({
	type: record.type,
	source: ikSource(record.name, zone),
	target: ikQuote(record.type, record.content),
	ttl: record.ttl ?? INFOMANIAK_DEFAULT_TTL,
});

const infomaniakClient: DnsClient = {
	async listZones(config) {
		const domains: { customer_name: string }[] = [];
		for (let page = 1; ; page++) {
			const body = await ikRequest<{ customer_name: string }[]>(
				config,
				`/1/products?service_name=domain&page=${page}&per_page=${INFOMANIAK_PRODUCTS_PER_PAGE}`,
			);
			domains.push(...(body.data ?? []));
			if (page >= (body.pages ?? 1)) break;
		}
		// v2 record endpoints are keyed by zone name, not product id.
		return domains.map((d) => ({ id: d.customer_name, name: d.customer_name }));
	},

	async listRecords(config, zoneId) {
		const records = await ikFetch<InfomaniakRecord[]>(
			config,
			`/2/zones/${encodeURIComponent(zoneId)}/records?with=records_description`,
		);
		return records.map((record) => ({
			id: String(record.id),
			type: record.type,
			name: ikFqdn(record.source, zoneId),
			content: ikUnquote(record.target),
			ttl: Number(record.ttl),
		}));
	},

	async upsertRecord(config, record) {
		const source = ikSource(record.name, record.zoneId);
		const expected = ikUnquote(ikQuote(record.type, record.content));
		const zone = encodeURIComponent(record.zoneId);
		const query = new URLSearchParams({
			"filter[source]": source,
			"filter[types][]": record.type,
		});
		const candidates = await ikFetch<InfomaniakRecord[]>(
			config,
			`/2/zones/${zone}/records?${query}`,
		);
		// The server-side filter isn't guaranteed to be exact; re-check here so
		// an over-match can't turn an update into a duplicate.
		const match = candidates.find(
			(c) =>
				c.type === record.type &&
				ikNormalizeSource(c.source) === source &&
				ikUnquote(c.target) === expected,
		);
		const body = JSON.stringify(ikPayload(record, record.zoneId));
		if (match) {
			await ikFetch(config, `/2/zones/${zone}/records/${match.id}`, {
				method: "PUT",
				body,
			});
			return { id: String(match.id) };
		}
		const created = await ikFetch<InfomaniakRecord | number | string>(
			config,
			`/2/zones/${zone}/records`,
			{ method: "POST", body },
		);
		return {
			id:
				typeof created === "object" && created !== null
					? String(created.id)
					: String(created),
		};
	},

	async updateRecord(config, zoneId, recordId, record) {
		await ikFetch(
			config,
			`/2/zones/${encodeURIComponent(zoneId)}/records/${recordId}`,
			{ method: "PUT", body: JSON.stringify(ikPayload(record, zoneId)) },
		);
		return { id: recordId };
	},

	async deleteRecord(config, zoneId, recordId) {
		await ikFetch(
			config,
			`/2/zones/${encodeURIComponent(zoneId)}/records/${recordId}`,
			{ method: "DELETE" },
		);
	},

	async testConnection(config) {
		await ikFetch(config, "/1/products?service_name=domain&per_page=1");
	},
};

type OvhRecord = {
	id: number;
	zone: string;
	fieldType: string;
	subDomain: string | null;
	target: string;
	ttl: number | null;
};

const OVH_RECORD_CONCURRENCY = 8;
// Requests are signed with the API's clock; a skewed local clock gets every
// call rejected, so the drift is measured and cached.
const OVH_CLOCK_SKEW_TTL_MS = 60 * 60 * 1000;
const ovhClockSkews = new Map<
	string,
	{ deltaSeconds: number; measuredAt: number }
>();

const nowSeconds = () => Math.floor(Date.now() / 1000);

const ovhTimestamp = async (baseUrl: string) => {
	const cached = ovhClockSkews.get(baseUrl);
	if (cached && Date.now() - cached.measuredAt < OVH_CLOCK_SKEW_TTL_MS) {
		return nowSeconds() + cached.deltaSeconds;
	}
	const response = await providerFetch(`${baseUrl}/auth/time`);
	const serverTime = Number(await response.text());
	if (!response.ok || !Number.isFinite(serverTime)) {
		throw new ConvexError(
			`OVH: could not read the API server time (status ${response.status})`,
		);
	}
	const deltaSeconds = serverTime - nowSeconds();
	ovhClockSkews.set(baseUrl, { deltaSeconds, measuredAt: Date.now() });
	return nowSeconds() + deltaSeconds;
};

const sha1Hex = async (value: string) => {
	const digest = await crypto.subtle.digest(
		"SHA-1",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
};

const ovhFetch = async <T>(
	config: DnsConfig,
	path: string,
	init: { method?: string; body?: unknown } = {},
): Promise<T> => {
	const baseUrl = OVH_ENDPOINTS[config.endpoint ?? "ovh-eu"];
	if (!baseUrl)
		throw new ConvexError(`OVH: unknown endpoint "${config.endpoint}"`);
	const url = `${baseUrl}${path}`;
	const method = init.method ?? "GET";
	const body = init.body === undefined ? "" : JSON.stringify(init.body);
	const timestamp = await ovhTimestamp(baseUrl);
	const signature = await sha1Hex(
		[
			config.applicationSecret,
			config.consumerKey,
			method,
			url,
			body,
			timestamp,
		].join("+"),
	);
	const response = await providerFetch(url, {
		method,
		...(body ? { body } : {}),
		headers: {
			"Content-Type": "application/json",
			"X-Ovh-Application": config.applicationKey,
			"X-Ovh-Consumer": config.consumerKey,
			"X-Ovh-Timestamp": String(timestamp),
			"X-Ovh-Signature": `$1$${signature}`,
		},
	});
	const payload = await readJson(response);
	if (!response.ok) {
		const detail =
			payload && typeof payload === "object" && "message" in payload
				? String(payload.message)
				: undefined;
		throw new ConvexError(
			`OVH: request to ${method} ${path} failed${
				detail ? `: ${detail}` : ` (status ${response.status})`
			}`,
		);
	}
	return payload as T;
};

const ovhSubDomain = (name: string, zone: string) => {
	const fqdn = name.replace(/\.$/, "");
	if (fqdn === zone) return "";
	const suffix = `.${zone}`;
	return fqdn.endsWith(suffix) ? fqdn.slice(0, -suffix.length) : fqdn;
};

const ovhFqdn = (subDomain: string | null, zone: string) =>
	subDomain ? `${subDomain}.${zone}` : zone;

const mapWithConcurrency = async <T, R>(
	items: T[],
	limit: number,
	run: (item: T) => Promise<R>,
) => {
	const results = new Array<R>(items.length);
	let cursor = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (cursor < items.length) {
				const index = cursor++;
				results[index] = await run(items[index] as T);
			}
		}),
	);
	return results;
};

// OVH only serves zone changes after an explicit refresh. The write already
// succeeded when this fails, so report that rather than "nothing applied".
const ovhRefresh = async (config: DnsConfig, zone: string) => {
	try {
		await ovhFetch(config, `/domain/zone/${encodeURIComponent(zone)}/refresh`, {
			method: "POST",
		});
	} catch (error) {
		throw new ConvexError(
			`OVH: the record change was applied, but refreshing zone "${zone}" failed, so it is not served yet. The next successful change to this zone will publish it, or you can refresh the zone from the OVH manager. Cause: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
};

// Undoes the delete half of a type change when the replacement fails; a
// failed POST and a failed refresh are reported differently because only the
// former means the record is really gone.
const ovhRestore = async (
	config: DnsConfig,
	zone: string,
	record: OvhRecord,
	cause: unknown,
) => {
	const causeMessage = cause instanceof Error ? cause.message : String(cause);
	try {
		await ovhFetch(config, `/domain/zone/${encodeURIComponent(zone)}/record`, {
			method: "POST",
			body: {
				fieldType: record.fieldType,
				subDomain: record.subDomain ?? "",
				target: record.target,
				...(record.ttl === null ? {} : { ttl: record.ttl }),
			},
		});
	} catch {
		throw new ConvexError(
			`OVH: could not replace the record and could not restore the original one, which has been deleted. Recreate it manually: ${record.fieldType} ${ovhFqdn(record.subDomain, zone)} -> ${record.target}. Original failure: ${causeMessage}`,
		);
	}
	try {
		await ovhRefresh(config, zone);
	} catch {
		throw new ConvexError(
			`OVH: the replacement failed and the original record was restored, but refreshing zone "${zone}" failed, so the restore is not served yet. Do not recreate it — the next successful change to this zone will publish it. Original failure: ${causeMessage}`,
		);
	}
};

const ovhRecordBody = (
	record: { name: string; content: string; ttl?: number },
	zone: string,
) => ({
	subDomain: ovhSubDomain(record.name, zone),
	target: record.content,
	...(record.ttl === undefined ? {} : { ttl: record.ttl }),
});

// A `/domain/zone/*` access rule doesn't cover the bare `/domain/zone` listing.
const ovhListZoneNames = async (config: DnsConfig) => {
	try {
		return await ovhFetch<string[]>(config, "/domain/zone");
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.includes("has not been granted")
		) {
			throw new ConvexError(
				"OVH: the credentials are missing the `GET /domain/zone` right, which lists your zones. A `GET /domain/zone/*` rule does not cover it — add the rule without the wildcard as well.",
			);
		}
		throw error;
	}
};

const ovhAssertZone = (config: DnsConfig, zoneId: string) => {
	if (config.zone && zoneId !== config.zone) {
		throw new ConvexError(
			`OVH: this provider is restricted to the zone "${config.zone}", not "${zoneId}"`,
		);
	}
};

const ovhClient: DnsClient = {
	async listZones(config) {
		if (config.zone) return [{ id: config.zone, name: config.zone }];
		return (await ovhListZoneNames(config)).map((zone) => ({
			id: zone,
			name: zone,
		}));
	},

	async listRecords(config, zoneId) {
		ovhAssertZone(config, zoneId);
		const zone = encodeURIComponent(zoneId);
		const ids = await ovhFetch<number[]>(config, `/domain/zone/${zone}/record`);
		const records = await mapWithConcurrency(
			ids,
			OVH_RECORD_CONCURRENCY,
			(id) => ovhFetch<OvhRecord>(config, `/domain/zone/${zone}/record/${id}`),
		);
		return records.map((record) => ({
			id: String(record.id),
			type: record.fieldType,
			name: ovhFqdn(record.subDomain, zoneId),
			content: record.target,
			ttl: record.ttl ?? 0,
		}));
	},

	async upsertRecord(config, record) {
		ovhAssertZone(config, record.zoneId);
		const zone = encodeURIComponent(record.zoneId);
		const subDomain = ovhSubDomain(record.name, record.zoneId);
		const existing = await ovhFetch<number[]>(
			config,
			`/domain/zone/${zone}/record?fieldType=${encodeURIComponent(record.type)}&subDomain=${encodeURIComponent(subDomain)}`,
		);
		let existingId: number | undefined;
		for (const id of existing) {
			const candidate = await ovhFetch<OvhRecord>(
				config,
				`/domain/zone/${zone}/record/${id}`,
			);
			if (candidate.target === record.content) {
				existingId = id;
				break;
			}
		}
		if (existingId !== undefined) {
			await ovhFetch(config, `/domain/zone/${zone}/record/${existingId}`, {
				method: "PUT",
				body: ovhRecordBody(record, record.zoneId),
			});
			await ovhRefresh(config, record.zoneId);
			return { id: String(existingId) };
		}
		const created = await ovhFetch<OvhRecord>(
			config,
			`/domain/zone/${zone}/record`,
			{
				method: "POST",
				body: {
					fieldType: record.type,
					...ovhRecordBody(record, record.zoneId),
				},
			},
		);
		await ovhRefresh(config, record.zoneId);
		return { id: String(created.id) };
	},

	async updateRecord(config, zoneId, recordId, record) {
		ovhAssertZone(config, zoneId);
		const zone = encodeURIComponent(zoneId);
		const existing = await ovhFetch<OvhRecord>(
			config,
			`/domain/zone/${zone}/record/${recordId}`,
		);
		// Updates can't change fieldType, so a type change is delete + create.
		// Delete first: OVH rejects a CNAME next to other data on the same name.
		if (existing.fieldType !== record.type) {
			await ovhFetch(config, `/domain/zone/${zone}/record/${recordId}`, {
				method: "DELETE",
			});
			let created: OvhRecord;
			try {
				created = await ovhFetch<OvhRecord>(
					config,
					`/domain/zone/${zone}/record`,
					{
						method: "POST",
						body: { fieldType: record.type, ...ovhRecordBody(record, zoneId) },
					},
				);
			} catch (error) {
				await ovhRestore(config, zoneId, existing, error);
				throw error;
			}
			await ovhRefresh(config, zoneId);
			return { id: String(created.id) };
		}
		await ovhFetch(config, `/domain/zone/${zone}/record/${recordId}`, {
			method: "PUT",
			body: ovhRecordBody(record, zoneId),
		});
		await ovhRefresh(config, zoneId);
		return { id: recordId };
	},

	async deleteRecord(config, zoneId, recordId) {
		ovhAssertZone(config, zoneId);
		await ovhFetch(
			config,
			`/domain/zone/${encodeURIComponent(zoneId)}/record/${recordId}`,
			{ method: "DELETE" },
		);
		await ovhRefresh(config, zoneId);
	},

	async testConnection(config) {
		if (config.zone) {
			await ovhFetch(config, `/domain/zone/${encodeURIComponent(config.zone)}`);
			return;
		}
		await ovhListZoneNames(config);
	},
};

export const FETCH_DNS_CLIENTS: Partial<Record<DnsProviderType, DnsClient>> = {
	cloudflare: cloudflareClient,
	porkbun: porkbunClient,
	infomaniak: infomaniakClient,
	ovh: ovhClient,
};
