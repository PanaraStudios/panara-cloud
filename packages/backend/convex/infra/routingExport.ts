// Domains, redirects, published ports and basic auth users of a routing
// owner, for project export/import (platform/lib/transferRegistry.ts).
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { assertPublishedPortAllowed } from "../lib/swarmPolicy";
import { certificateType, portProtocol } from "../tables/infra";
import {
	assertHostsFree,
	listOwnerDomains,
	MAX_DOMAINS_PER_OWNER,
	MAX_PORTS_PER_OWNER,
	MAX_REDIRECTS_PER_OWNER,
	MAX_USERS_PER_OWNER,
	type RoutingOwner,
} from "./routing";
import {
	validateDomainFields,
	validatePort,
	validateRegex,
	validateUsername,
} from "./validation";

export const routingRow = v.object({
	domains: v.array(
		v.object({
			host: v.string(),
			path: v.string(),
			port: v.number(),
			https: v.boolean(),
			certificateType,
			customCertResolver: v.optional(v.string()),
			customEntrypoint: v.optional(v.string()),
			internalPath: v.string(),
			stripPath: v.boolean(),
			serviceName: v.optional(v.string()),
			middlewares: v.array(v.string()),
			enabled: v.boolean(),
		}),
	),
	redirects: v.array(
		v.object({
			regex: v.string(),
			replacement: v.string(),
			permanent: v.boolean(),
		}),
	),
	ports: v.array(
		v.object({
			publishedPort: v.number(),
			targetPort: v.number(),
			protocol: portProtocol,
			publishMode: v.union(v.literal("ingress"), v.literal("host")),
		}),
	),
	// apr1 hashes, only in encrypted exports.
	basicAuth: v.optional(
		v.array(v.object({ username: v.string(), passwordHash: v.string() })),
	),
});

export type RoutingRow = typeof routingRow.type;

export const exportRouting = async (
	ctx: QueryCtx,
	owner: RoutingOwner,
	includeSecrets: boolean,
): Promise<RoutingRow> => {
	const domains = await listOwnerDomains(ctx, owner);
	const redirects = await ctx.db
		.query("redirects")
		.withIndex("by_owner", (q) =>
			q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
		)
		.take(MAX_REDIRECTS_PER_OWNER);
	const ports = await ctx.db
		.query("ports")
		.withIndex("by_owner", (q) =>
			q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
		)
		.take(MAX_PORTS_PER_OWNER);
	const users = includeSecrets
		? await ctx.db
				.query("basicAuthUsers")
				.withIndex("by_owner_and_username", (q) =>
					q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
				)
				.take(MAX_USERS_PER_OWNER)
		: [];
	return {
		domains: domains.map((d) => ({
			host: d.host,
			path: d.path,
			port: d.port,
			https: d.https,
			certificateType: d.certificateType,
			customCertResolver: d.customCertResolver,
			customEntrypoint: d.customEntrypoint,
			internalPath: d.internalPath,
			stripPath: d.stripPath,
			serviceName: d.serviceName,
			middlewares: d.middlewares,
			enabled: d.enabled,
		})),
		redirects: redirects.map((r) => ({
			regex: r.regex,
			replacement: r.replacement,
			permanent: r.permanent,
		})),
		ports: ports.map((p) => ({
			publishedPort: p.publishedPort,
			targetPort: p.targetPort,
			protocol: p.protocol,
			publishMode: p.publishMode,
		})),
		...(includeSecrets
			? {
					basicAuth: users.map((u) => ({
						username: u.username,
						passwordHash: u.passwordHash,
					})),
				}
			: {}),
	};
};

const SOURCE_IP_HOST =
	/-\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}\.(sslip|traefik)\.(io|me)$/;
const HASH = /^\$(apr1|2[aby]|5|6)\$[./A-Za-z0-9$]{1,200}$/;

// Recreates the rows for an owner that was just registered on `serverId`.
// A domain or port already taken on that server is skipped with a warning
// rather than inserted disabled: host+path uniqueness would otherwise block
// the service that already owns it.
export const importRouting = async (
	ctx: MutationCtx,
	input: {
		organizationId: string;
		owner: RoutingOwner;
		serverId: Id<"servers"> | undefined;
		name: string;
		routing: RoutingRow;
	},
	warnings: string[],
) => {
	const { organizationId, owner, serverId, name, routing } = input;
	const isCompose = owner.kind === "compose";
	if (
		routing.domains.length > MAX_DOMAINS_PER_OWNER ||
		routing.redirects.length > MAX_REDIRECTS_PER_OWNER ||
		routing.ports.length > MAX_PORTS_PER_OWNER ||
		(routing.basicAuth?.length ?? 0) > MAX_USERS_PER_OWNER
	) {
		throw new ConvexError(`Too many routing entries on "${name}"`);
	}
	for (const domain of routing.domains) {
		const values = validateDomainFields(domain, isCompose);
		const clash = await assertHostsFree(ctx, serverId, [
			{ owner, ...values },
		]).then(
			() => false,
			() => true,
		);
		if (clash) {
			warnings.push(
				`Domain ${values.host}${values.path === "/" ? "" : values.path} is already used on this server or reserved for Panara Cloud; it was not imported on "${name}".`,
			);
			continue;
		}
		if (SOURCE_IP_HOST.test(values.host)) {
			warnings.push(
				`Domain ${values.host} on "${name}" was generated for the source server's IP; generate a new one.`,
			);
		}
		await ctx.db.insert("domains", {
			organizationId,
			owner,
			serverId,
			...values,
		});
	}
	if (isCompose) return;
	for (const redirect of routing.redirects) {
		if (!redirect.replacement || redirect.replacement.length > 1000) {
			throw new ConvexError("Invalid redirect replacement");
		}
		await ctx.db.insert("redirects", {
			organizationId,
			owner,
			regex: validateRegex(redirect.regex),
			replacement: redirect.replacement,
			permanent: redirect.permanent,
		});
	}
	for (const port of routing.ports) {
		validatePort(port.publishedPort, "Published port");
		validatePort(port.targetPort, "Target port");
		assertPublishedPortAllowed(port.publishedPort, serverId);
		const taken = await ctx.db
			.query("ports")
			.withIndex("by_serverId_and_publishedPort", (q) =>
				q.eq("serverId", serverId).eq("publishedPort", port.publishedPort),
			)
			.take(10);
		if (taken.some((p) => p.protocol === port.protocol)) {
			warnings.push(
				`Port ${port.publishedPort}/${port.protocol} is already published on this server; it was not imported on "${name}".`,
			);
			continue;
		}
		await ctx.db.insert("ports", {
			organizationId,
			owner,
			serverId,
			...port,
		});
	}
	const seen = new Set<string>();
	for (const user of routing.basicAuth ?? []) {
		const username = validateUsername(user.username);
		if (seen.has(username)) continue;
		if (!HASH.test(user.passwordHash)) {
			throw new ConvexError("Invalid basic auth password hash");
		}
		seen.add(username);
		await ctx.db.insert("basicAuthUsers", {
			organizationId,
			owner,
			username,
			passwordHash: user.passwordHash,
		});
	}
};
