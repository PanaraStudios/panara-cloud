import { ConvexError, v } from "convex/values";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	action,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "../_generated/server";
import { recordOwnerEvent } from "../lib/serviceEvents";
import { certificateType, routingOwner } from "../tables/infra";
import { partitionOf } from "./access";
import { BUNNY_CDN_IPS } from "./cdn";
import { enqueueOp } from "./hostJobs";
import {
	assertHostsFree,
	enqueueRoutingSync,
	listOwnerDomains,
	MAX_DOMAINS_PER_OWNER,
	requireOwnedRowPermission,
	requireRoutingPermission,
} from "./routing";
import {
	type DomainFields,
	normalizeHost,
	validateDomainFields,
} from "./validation";

const domainFields = {
	host: v.string(),
	path: v.optional(v.string()),
	port: v.optional(v.number()),
	https: v.boolean(),
	certificateType,
	customCertResolver: v.optional(v.string()),
	customEntrypoint: v.optional(v.string()),
	internalPath: v.optional(v.string()),
	stripPath: v.optional(v.boolean()),
	serviceName: v.optional(v.string()),
	middlewares: v.optional(v.array(v.string())),
	enabled: v.optional(v.boolean()),
};

const loadDomain = async (ctx: MutationCtx, domainId: Id<"domains">) => {
	const domain = await ctx.db.get("domains", domainId);
	if (!domain) throw new ConvexError("Domain not found");
	return domain;
};

const checkHostAvailable = (
	ctx: MutationCtx,
	domain: Pick<Doc<"domains">, "serverId" | "host" | "path" | "owner"> & {
		_id?: Id<"domains">;
	},
) => assertHostsFree(ctx, domain.serverId, [domain]);

export const listByOwner = query({
	args: { owner: routingOwner },
	handler: async (ctx, { owner }) => {
		await requireRoutingPermission(ctx, owner, "domain", "read");
		return await listOwnerDomains(ctx, owner);
	},
});

export const get = query({
	args: { domainId: v.id("domains") },
	handler: async (ctx, { domainId }) => {
		const domain = await ctx.db.get("domains", domainId);
		if (!domain) return null;
		await requireOwnedRowPermission(ctx, domain, "domain", "read");
		return domain;
	},
});

export const create = mutation({
	args: { owner: routingOwner, ...domainFields },
	handler: async (ctx, { owner, ...fields }) => {
		const { row, userId } = await requireRoutingPermission(
			ctx,
			owner,
			"domain",
			"create",
		);
		const values = validateDomainFields(
			fields as DomainFields,
			owner.kind === "compose",
		);
		const existing = await listOwnerDomains(ctx, owner);
		if (existing.length >= MAX_DOMAINS_PER_OWNER) {
			throw new ConvexError(
				`A service can have at most ${MAX_DOMAINS_PER_OWNER} domains`,
			);
		}
		await checkHostAvailable(ctx, { serverId: row.serverId, owner, ...values });
		const domainId = await ctx.db.insert("domains", {
			organizationId: row.organizationId,
			owner,
			serverId: row.serverId,
			...values,
		});
		await recordOwnerEvent(
			ctx,
			owner,
			row.organizationId,
			"config.domains",
			userId,
			{ host: values.host, action: "create" },
		);
		await enqueueRoutingSync(ctx, owner, userId);
		return domainId;
	},
});

export const update = mutation({
	args: { domainId: v.id("domains"), ...domainFields },
	handler: async (ctx, { domainId, ...fields }) => {
		const domain = await loadDomain(ctx, domainId);
		const { userId } = await requireOwnedRowPermission(
			ctx,
			domain,
			"domain",
			"create",
		);
		const values = validateDomainFields(
			fields as DomainFields,
			domain.owner.kind === "compose",
		);
		await checkHostAvailable(ctx, {
			_id: domainId,
			serverId: domain.serverId,
			owner: domain.owner,
			...values,
		});
		await ctx.db.patch("domains", domainId, values);
		await recordOwnerEvent(
			ctx,
			domain.owner,
			domain.organizationId,
			"config.domains",
			userId,
			{ host: values.host, action: "update" },
		);
		await enqueueRoutingSync(ctx, domain.owner, userId);
	},
});

export const setEnabled = mutation({
	args: { domainId: v.id("domains"), enabled: v.boolean() },
	handler: async (ctx, { domainId, enabled }) => {
		const domain = await loadDomain(ctx, domainId);
		const { userId } = await requireOwnedRowPermission(
			ctx,
			domain,
			"domain",
			"create",
		);
		await ctx.db.patch("domains", domainId, { enabled });
		await recordOwnerEvent(
			ctx,
			domain.owner,
			domain.organizationId,
			"config.domains",
			userId,
			{
				host: domain.host,
				action: "update",
				fields: [enabled ? "enabled" : "disabled"],
			},
		);
		await enqueueRoutingSync(ctx, domain.owner, userId);
		// Application routes are rewritten right away; compose domains are
		// labels in the compose file, applied on the next deploy.
		return { enabled, requiresRedeploy: domain.owner.kind === "compose" };
	},
});

export const remove = mutation({
	args: { domainId: v.id("domains") },
	handler: async (ctx, { domainId }) => {
		const domain = await ctx.db.get("domains", domainId);
		if (!domain) return;
		const { userId } = await requireOwnedRowPermission(
			ctx,
			domain,
			"domain",
			"delete",
		);
		await ctx.db.delete("domains", domainId);
		await recordOwnerEvent(
			ctx,
			domain.owner,
			domain.organizationId,
			"config.domains",
			userId,
			{ host: domain.host, action: "remove" },
		);
		await enqueueRoutingSync(ctx, domain.owner, userId);
	},
});

// Free test domains: <app>-<hash>-<ip>.sslip.io resolves to <ip>.
export const generateTestHost = mutation({
	args: { owner: routingOwner },
	handler: async (ctx, { owner }) => {
		const { row } = await requireRoutingPermission(
			ctx,
			owner,
			"domain",
			"create",
		);
		let ip = "127.0.0.1";
		if (row.serverId) {
			const server = await ctx.db.get("servers", row.serverId);
			if (server?.ipAddress) ip = server.ipAddress;
		} else {
			const settings = await ctx.db
				.query("webServerSettings")
				.withIndex("by_key", (q) => q.eq("key", "instance"))
				.unique();
			if (settings?.serverIp) ip = settings.serverIp;
		}
		const hash = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) =>
			b.toString(16).padStart(2, "0"),
		).join("");
		const slugIp = ip.replaceAll(".", "-").replaceAll(":", "-");
		const name = row.appName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
		return `${name.slice(0, 40)}-${hash}-${slugIp}.sslip.io`;
	},
});

const ownerIp = async (ctx: QueryCtx, serverId: Id<"servers"> | undefined) => {
	if (serverId) {
		const server = await ctx.db.get("servers", serverId);
		return server?.ipAddress || null;
	}
	const settings = await ctx.db
		.query("webServerSettings")
		.withIndex("by_key", (q) => q.eq("key", "instance"))
		.unique();
	return settings?.serverIp || null;
};

// The address the owner's domains should point at: its server's IP, or the
// panel's configured IP. null means sslip.io hosts can't resolve.
export const serverIp = query({
	args: { owner: routingOwner },
	handler: async (ctx, { owner }) => {
		const { row } = await requireRoutingPermission(
			ctx,
			owner,
			"domain",
			"read",
		);
		return await ownerIp(ctx, row.serverId);
	},
});

const MAX_PROBED_ADDRESSES = 64;

// IP candidates: the server's interface addresses and its
// public IP, read on the host by an agent job (`{ addresses }` in
// api.infra.snapshots.opResult). Pass the job to validateHost.
export const probeAddresses = mutation({
	args: { owner: routingOwner },
	handler: async (ctx, { owner }) => {
		const { row, userId } = await requireRoutingPermission(
			ctx,
			owner,
			"domain",
			"read",
		);
		return await enqueueOp(
			ctx,
			{
				organizationId: row.organizationId,
				partition: partitionOf(row.serverId),
				userId,
			},
			`addresses:${partitionOf(row.serverId)}`,
			{ kind: "infra.probeAddresses", serverId: row.serverId },
			{ restricted: false, idempotent: true },
		);
	},
});

const isIp = (value: string) =>
	/^\d{1,3}(\.\d{1,3}){3}$/.test(value) ||
	(/^[0-9a-fA-F:]+$/.test(value) && value.includes(":"));

// Every address the owner's domains may point at: the configured IP plus
// what a finished probeAddresses job of the same host reported.
export const expectedAddresses = query({
	args: { owner: routingOwner, probeJobId: v.optional(v.id("jobs")) },
	handler: async (ctx, { owner, probeJobId }) => {
		const { row } = await requireRoutingPermission(
			ctx,
			owner,
			"domain",
			"read",
		);
		const addresses = new Set<string>();
		const configured = await ownerIp(ctx, row.serverId);
		if (configured) addresses.add(configured);
		const job = probeJobId ? await ctx.db.get("jobs", probeJobId) : null;
		if (
			job &&
			job.organizationId === row.organizationId &&
			job.spec.kind === "infra.probeAddresses" &&
			job.spec.serverId === row.serverId
		) {
			const op = await ctx.db
				.query("infraOps")
				.withIndex("by_jobId", (q) => q.eq("jobId", job._id))
				.unique();
			try {
				const probed = JSON.parse(op?.result ?? "{}") as {
					addresses?: unknown;
				};
				if (Array.isArray(probed.addresses)) {
					for (const address of probed.addresses.slice(
						0,
						MAX_PROBED_ADDRESSES,
					)) {
						if (typeof address === "string" && isIp(address)) {
							addresses.add(address);
						}
					}
				}
			} catch {}
		}
		return [...addresses];
	},
});

const ipv4ToInt = (ip: string) =>
	ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;

const inCidr = (ip: string, cidr: string) => {
	const [network, bits] = cidr.split("/");
	if (!network || !bits || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
	const mask = (0xffffffff << (32 - Number(bits))) >>> 0;
	return (ipv4ToInt(ip) & mask) === (ipv4ToInt(network) & mask);
};

const CDN_PROVIDERS: {
	name: string;
	message: string;
	ranges: string[];
	ips?: ReadonlySet<string>;
}[] = [
	{
		name: "Cloudflare",
		message:
			"Domain is behind Cloudflare - actual IP is masked by Cloudflare proxy",
		ranges: [
			"173.245.48.0/20",
			"103.21.244.0/22",
			"103.22.200.0/22",
			"103.31.4.0/22",
			"141.101.64.0/18",
			"108.162.192.0/18",
			"190.93.240.0/20",
			"188.114.96.0/20",
			"197.234.240.0/22",
			"198.41.128.0/17",
			"162.158.0.0/15",
			"104.16.0.0/13",
			"104.24.0.0/14",
			"172.64.0.0/13",
			"131.0.72.0/22",
		],
	},
	{
		name: "Bunny CDN",
		message: "Domain is behind Bunny CDN - actual IP is masked by CDN proxy",
		ranges: [],
		ips: BUNNY_CDN_IPS,
	},
	{
		name: "Fastly",
		message: "Domain is behind Fastly - actual IP is masked by CDN proxy",
		ranges: [
			"23.235.32.0/20",
			"43.249.72.0/22",
			"103.244.50.0/24",
			"103.245.222.0/23",
			"103.245.224.0/24",
			"104.156.80.0/20",
			"140.248.64.0/18",
			"140.248.128.0/17",
			"146.75.0.0/17",
			"151.101.0.0/16",
			"157.52.64.0/18",
			"167.82.0.0/17",
			"167.82.128.0/20",
			"167.82.160.0/20",
			"167.82.224.0/20",
			"172.111.64.0/18",
			"185.31.16.0/22",
			"199.27.72.0/21",
			"199.232.0.0/16",
		],
	},
	{
		name: "Arvancloud",
		message: "Domain is behind Arvancloud - actual IP is masked by CDN proxy",
		ranges: [
			"185.143.232.0/22",
			"188.229.116.16/29",
			"94.101.182.0/27",
			"2.144.3.128/28",
			"89.45.48.64/28",
			"37.32.16.0/27",
			"37.32.17.0/27",
			"37.32.18.0/27",
			"37.32.19.0/27",
			"185.215.232.0/22",
			"178.131.120.48/28",
		],
	},
];

export const detectCdn = (ip: string) =>
	CDN_PROVIDERS.find(
		(provider) =>
			provider.ips?.has(ip) ||
			provider.ranges.some((range) => inCidr(ip, range)),
	) ?? null;

// Convex actions have no resolver, so A/AAAA records come from DNS over HTTPS.
const resolveHost = async (host: string): Promise<string[]> => {
	const lookups = await Promise.allSettled(
		["A", "AAAA"].map(async (type) => {
			const response = await fetch(
				`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
				{ headers: { accept: "application/dns-json" } },
			);
			if (!response.ok)
				throw new Error(`DNS lookup failed (${response.status})`);
			const body = (await response.json()) as {
				Answer?: { type: number; data: string }[];
			};
			return (body.Answer ?? [])
				.filter((answer) => answer.type === 1 || answer.type === 28)
				.map((answer) => answer.data);
		}),
	);
	const ips = lookups.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
	if (ips.length > 0) return ips;
	const failure = lookups.find((r) => r.status === "rejected");
	throw failure?.status === "rejected" && failure.reason instanceof Error
		? failure.reason
		: new Error(`No DNS records found for ${host}`);
};

export type DomainValidation = {
	isValid: boolean;
	resolvedIp?: string;
	error?: string;
	cdnProvider?: string;
};

// Validates a domain: does the host resolve to one of the
// server's addresses (or a known CDN)?
export const validateHost = action({
	args: {
		owner: routingOwner,
		host: v.string(),
		probeJobId: v.optional(v.id("jobs")),
	},
	handler: async (
		ctx,
		{ owner, host, probeJobId },
	): Promise<DomainValidation> => {
		const expected: string[] = await ctx.runQuery(
			api.infra.domains.expectedAddresses,
			{ owner, probeJobId },
		);
		try {
			const clean = normalizeHost(
				host.replace(/^https?:\/\//, "").split("/")[0] ?? "",
			);
			return checkResolution(await resolveHost(clean), expected);
		} catch (error) {
			return {
				isValid: false,
				error:
					error instanceof Error ? error.message : "Failed to resolve domain",
			};
		}
	},
});

export const checkResolution = (
	ips: string[],
	expected: string[],
): DomainValidation => {
	const resolvedIp = ips.join(", ");
	const cdn = ips.map(detectCdn).find((provider) => provider !== null);
	if (cdn) {
		return {
			isValid: true,
			resolvedIp,
			cdnProvider: cdn.name,
			error: cdn.message,
		};
	}
	if (expected.length === 0) return { isValid: true, resolvedIp };
	const isValid = ips.some((ip) => expected.includes(ip));
	return {
		isValid,
		resolvedIp,
		error: isValid
			? undefined
			: `Domain resolves to ${resolvedIp} but should point to ${expected.join(" or ")}`,
	};
};
