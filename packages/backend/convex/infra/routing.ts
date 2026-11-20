// Routing API for the domains that own routable resources (applications,
// compose, previews). Call these plain functions from your own mutations and
// agent queries after authorizing; they are not registered Convex functions
// except for the internal cascade below.
import { ConvexError, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	internalMutation,
	type MutationCtx,
	type QueryCtx,
} from "../_generated/server";
import { enqueueJob } from "../lib/jobs";
import {
	type Access,
	type Action,
	type Resource,
	requireServicePermission,
} from "../lib/permissions";
import { type composeType, routingOwner } from "../tables/infra";
import { partitionOf } from "./access";
import { loadWebServerSettings } from "./webServer";

export type RoutingOwner = Infer<typeof routingOwner>;
export type ComposeType = Infer<typeof composeType>;

export const MAX_DOMAINS_PER_OWNER = 100;
export const MAX_REDIRECTS_PER_OWNER = 100;
export const MAX_USERS_PER_OWNER = 100;
export const MAX_PORTS_PER_OWNER = 100;
const CASCADE_BATCH = 100;

export const ownerGroup = (owner: RoutingOwner): string =>
	`${owner.kind}:${owner.id}`;

export const getRoutingOwner = (
	ctx: QueryCtx,
	owner: RoutingOwner,
): Promise<Doc<"routingOwners"> | null> =>
	ctx.db
		.query("routingOwners")
		.withIndex("by_owner", (q) =>
			q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
		)
		.unique();

// The service a routing owner belongs to: previews are scoped by the
// application they preview.
export const routingServiceId = (
	row: Pick<Doc<"routingOwners">, "owner" | "parent">,
): string =>
	row.owner.kind === "preview" && row.parent ? row.parent.id : row.owner.id;

// The permission check plus service access, for a routing owner.
export const requireRoutingPermission = async <R extends Resource>(
	ctx: QueryCtx,
	owner: RoutingOwner,
	resource: R,
	action: Action<R>,
): Promise<{ row: Doc<"routingOwners">; userId: string; access: Access }> => {
	const row = await getRoutingOwner(ctx, owner);
	if (!row) throw new ConvexError("Service not found");
	const access = await requireServicePermission(
		ctx,
		{ _id: routingServiceId(row), organizationId: row.organizationId },
		resource,
		action,
	);
	return { row, userId: access.userId, access };
};

// For rows that carry their routing owner (domains, ports, redirects, basic
// auth users).
export const requireOwnedRowPermission = async <R extends Resource>(
	ctx: QueryCtx,
	row: { owner: RoutingOwner; organizationId: string },
	resource: R,
	action: Action<R>,
): Promise<Access> => {
	const ownerRow = await getRoutingOwner(ctx, row.owner);
	const serviceId = ownerRow ? routingServiceId(ownerRow) : row.owner.id;
	return await requireServicePermission(
		ctx,
		{ _id: serviceId, organizationId: row.organizationId },
		resource,
		action,
	);
};

const hostnameOf = (value: string | undefined) => {
	if (!value) return null;
	try {
		return new URL(
			/^[a-z]+:\/\//i.test(value) ? value : `http://${value}`,
		).hostname.toLowerCase();
	} catch {
		return null;
	}
};

// Hosts that serve Panara Cloud itself (panel, auth, Convex API and site).
export const reservedHosts = async (ctx: QueryCtx): Promise<Set<string>> => {
	const settings = await loadWebServerSettings(ctx);
	const hosts = [
		settings?.host,
		process.env.SITE_URL,
		process.env.CONVEX_SITE_URL,
		process.env.CONVEX_CLOUD_URL,
	]
		.map(hostnameOf)
		.filter((host): host is string => !!host);
	return new Set(hosts);
};

const MAX_HOST_ROWS = 200;

// Traefik matches the most specific rule first, so a service adding a path
// under another service's host takes over part of its traffic. Sharing a
// host across paths is only allowed between services of one organization,
// and a signed-in caller must be able to manage the other service's domains.
export const assertHostsFree = async (
	ctx: QueryCtx,
	serverId: Id<"servers"> | undefined,
	domains: (Pick<Doc<"domains">, "host" | "path" | "owner"> & {
		_id?: Id<"domains">;
	})[],
) => {
	const reserved = await reservedHosts(ctx);
	const signedIn = (await ctx.auth.getUserIdentity()) !== null;
	for (const domain of domains) {
		const organizationId = (await getRoutingOwner(ctx, domain.owner))
			?.organizationId;
		const label = `${domain.host}${domain.path === "/" ? "" : domain.path}`;
		if (reserved.has(domain.host.toLowerCase())) {
			throw new ConvexError(
				`${domain.host} is reserved for Panara Cloud and can't be used by a service`,
			);
		}
		const rows = await ctx.db
			.query("domains")
			.withIndex("by_serverId_and_host_and_path", (q) =>
				q.eq("serverId", serverId).eq("host", domain.host),
			)
			.take(MAX_HOST_ROWS);
		for (const row of rows) {
			if (row._id === domain._id) continue;
			if (row.path === domain.path) {
				throw new ConvexError(`${label} is already used on the target server`);
			}
			if (
				row.owner.kind === domain.owner.kind &&
				row.owner.id === domain.owner.id
			) {
				continue;
			}
			const shared =
				row.organizationId === organizationId &&
				(!signedIn ||
					(await requireOwnedRowPermission(ctx, row, "domain", "create").then(
						() => true,
						() => false,
					)));
			if (!shared) {
				throw new ConvexError(
					`${domain.host} is already used by another service on the target server`,
				);
			}
		}
	}
};

// Creates or updates the routing owner for a resource. Call it whenever the
// resource is created or its server, appName or compose type changes; moving
// servers re-homes its domains and ports and reconciles both hosts.
export const registerRoutingOwner = async (
	ctx: MutationCtx,
	input: {
		organizationId: string;
		owner: RoutingOwner;
		serverId?: Id<"servers">;
		appName: string;
		composeType?: ComposeType;
		parent?: RoutingOwner;
		requestedBy?: string;
	},
): Promise<Id<"routingOwners">> => {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(input.appName)) {
		throw new ConvexError("Invalid appName");
	}
	const existing = await getRoutingOwner(ctx, input.owner);
	const fields = {
		organizationId: input.organizationId,
		owner: input.owner,
		serverId: input.serverId,
		appName: input.appName,
		composeType: input.composeType,
		parent: input.parent,
	};
	if (!existing) {
		return await ctx.db.insert("routingOwners", fields);
	}
	if (existing.organizationId !== input.organizationId) {
		throw new ConvexError("Routing owner belongs to another organization");
	}
	const moved =
		existing.serverId !== input.serverId || existing.appName !== input.appName;
	await ctx.db.replace("routingOwners", existing._id, fields);
	if (!moved) return existing._id;

	const domains = await listOwnerDomains(ctx, input.owner);
	if (existing.serverId !== input.serverId) {
		await assertHostsFree(ctx, input.serverId, domains);
		for (const domain of domains) {
			await ctx.db.patch("domains", domain._id, { serverId: input.serverId });
		}
		const ports = await ctx.db
			.query("ports")
			.withIndex("by_owner", (q) =>
				q.eq("owner.kind", input.owner.kind).eq("owner.id", input.owner.id),
			)
			.take(MAX_PORTS_PER_OWNER);
		for (const port of ports) {
			await ctx.db.patch("ports", port._id, { serverId: input.serverId });
		}
	}
	if (input.owner.kind !== "compose") {
		await enqueueRoutingRemoval(ctx, existing, input.requestedBy);
		await enqueueRoutingSync(ctx, input.owner, input.requestedBy);
	}
	return existing._id;
};

// Deletes the owner with its domains, redirects, basic auth users and ports,
// and removes its Traefik configuration from the host.
export const removeRoutingOwner = async (
	ctx: MutationCtx,
	owner: RoutingOwner,
	requestedBy?: string,
) => {
	const existing = await getRoutingOwner(ctx, owner);
	if (!existing) return;
	await ctx.db.delete("routingOwners", existing._id);
	if (owner.kind !== "compose") {
		await enqueueRoutingRemoval(ctx, existing, requestedBy);
	}
	await ctx.scheduler.runAfter(0, internal.infra.routing.cascadeOwnerRows, {
		owner,
	});
};

const enqueueRoutingRemoval = (
	ctx: MutationCtx,
	row: Doc<"routingOwners">,
	requestedBy?: string,
) =>
	enqueueJob(ctx, {
		organizationId: row.organizationId,
		partition: partitionOf(row.serverId),
		group: ownerGroup(row.owner),
		spec: { kind: "infra.routingRemove", appName: row.appName },
		idempotent: true,
		maxAttempts: 3,
		requestedBy,
	});

export const cascadeOwnerRows = internalMutation({
	args: { owner: routingOwner },
	handler: async (ctx, { owner }) => {
		let deleted = 0;
		const domains = await listOwnerDomains(ctx, owner);
		for (const row of domains.slice(0, CASCADE_BATCH)) {
			await ctx.db.delete("domains", row._id);
			deleted++;
		}
		const redirects = await ctx.db
			.query("redirects")
			.withIndex("by_owner", (q) =>
				q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
			)
			.take(CASCADE_BATCH);
		for (const row of redirects) {
			await ctx.db.delete("redirects", row._id);
			deleted++;
		}
		const ports = await ctx.db
			.query("ports")
			.withIndex("by_owner", (q) =>
				q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
			)
			.take(CASCADE_BATCH);
		for (const row of ports) {
			await ctx.db.delete("ports", row._id);
			deleted++;
		}
		const users = await ctx.db
			.query("basicAuthUsers")
			.withIndex("by_owner_and_username", (q) =>
				q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
			)
			.take(CASCADE_BATCH);
		for (const user of users) {
			await ctx.db.delete("basicAuthUsers", user._id);
			deleted++;
		}
		if (deleted > 0) {
			await ctx.scheduler.runAfter(0, internal.infra.routing.cascadeOwnerRows, {
				owner,
			});
		}
	},
});

// Queues a Traefik reconcile for the owner on its host. Compose routing is
// carried by labels in the compose file, so it applies on the next deploy
// and nothing is queued. Collapses with an already queued sync.
export const enqueueRoutingSync = async (
	ctx: MutationCtx,
	owner: RoutingOwner,
	requestedBy?: string,
): Promise<Id<"jobs"> | null> => {
	if (owner.kind === "compose") return null;
	const row = await getRoutingOwner(ctx, owner);
	if (!row) return null;
	const group = ownerGroup(owner);
	const queued = await ctx.db
		.query("jobs")
		.withIndex("by_group_and_status", (q) =>
			q.eq("group", group).eq("status", "queued"),
		)
		.take(20);
	const pending = queued.find((job) => job.spec.kind === "infra.routingSync");
	if (pending) return pending._id;
	return await enqueueJob(ctx, {
		organizationId: row.organizationId,
		partition: partitionOf(row.serverId),
		group,
		spec: { kind: "infra.routingSync", owner },
		idempotent: true,
		maxAttempts: 3,
		requestedBy,
	});
};

// Previews reuse their application's basic auth, so they follow its changes.
export const enqueueDependentSyncs = async (
	ctx: MutationCtx,
	owner: RoutingOwner,
	requestedBy?: string,
) => {
	const children = await ctx.db
		.query("routingOwners")
		.withIndex("by_parent", (q) =>
			q.eq("parent.kind", owner.kind).eq("parent.id", owner.id),
		)
		.take(100);
	for (const child of children) {
		await enqueueRoutingSync(ctx, child.owner, requestedBy);
	}
};

export const listOwnerDomains = (ctx: QueryCtx, owner: RoutingOwner) =>
	ctx.db
		.query("domains")
		.withIndex("by_owner", (q) =>
			q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
		)
		.take(MAX_DOMAINS_PER_OWNER);

const listBasicAuth = async (ctx: QueryCtx, owner: RoutingOwner) =>
	(
		await ctx.db
			.query("basicAuthUsers")
			.withIndex("by_owner_and_username", (q) =>
				q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
			)
			.take(MAX_USERS_PER_OWNER)
	).map((user) => ({
		username: user.username,
		passwordHash: user.passwordHash,
	}));

export type RoutingDomain = {
	id: string;
	host: string;
	path: string;
	port: number;
	https: boolean;
	certificateType: "letsencrypt" | "none" | "custom";
	customCertResolver?: string;
	customEntrypoint?: string;
	internalPath: string;
	stripPath: boolean;
	serviceName?: string;
	middlewares: string[];
	enabled: boolean;
};

// Matches `ServiceRoutingInput` in apps/agent/src/infra/traefik, plus the
// fields deploys need (ports, compose type).
export type RoutingSnapshot = {
	owner: RoutingOwner;
	appName: string;
	serverId?: Id<"servers">;
	composeType?: ComposeType;
	domains: RoutingDomain[];
	redirects: {
		id: string;
		regex: string;
		replacement: string;
		permanent: boolean;
	}[];
	basicAuth: { username: string; passwordHash: string }[];
	ports: {
		publishedPort: number;
		targetPort: number;
		protocol: "tcp" | "udp";
		publishMode: "ingress" | "host";
	}[];
};

// Everything needed to route an owner. Call from lease-guarded agent queries
// (e.g. a deploy context) so deploys can write routing in the same job.
export const loadRoutingSnapshot = async (
	ctx: QueryCtx,
	owner: RoutingOwner,
): Promise<RoutingSnapshot | null> => {
	const row = await getRoutingOwner(ctx, owner);
	if (!row) return null;
	const domains = await listOwnerDomains(ctx, owner);
	const isPreview = owner.kind === "preview";
	const redirects = isPreview
		? []
		: await ctx.db
				.query("redirects")
				.withIndex("by_owner", (q) =>
					q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
				)
				.take(MAX_REDIRECTS_PER_OWNER);
	const basicAuth = await listBasicAuth(
		ctx,
		isPreview && row.parent ? row.parent : owner,
	);
	const ports = await ctx.db
		.query("ports")
		.withIndex("by_owner", (q) =>
			q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
		)
		.take(MAX_PORTS_PER_OWNER);
	return {
		owner,
		appName: row.appName,
		serverId: row.serverId,
		composeType: row.composeType,
		domains: domains.map((d) => ({
			id: d._id,
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
			id: r._id,
			regex: r.regex,
			replacement: r.replacement,
			permanent: r.permanent,
		})),
		basicAuth,
		ports: ports.map((p) => ({
			publishedPort: p.publishedPort,
			targetPort: p.targetPort,
			protocol: p.protocol,
			publishMode: p.publishMode,
		})),
	};
};
