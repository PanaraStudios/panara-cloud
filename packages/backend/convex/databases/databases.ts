import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	action,
	internalMutation,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "../_generated/server";
import { validateServiceNetworks } from "../infra/networks";
import { isAppNameInUse } from "../lib/appNames";
import { encryptSecret } from "../lib/crypto";
import { enqueueJob, type JobSpec, requestCancelRunning } from "../lib/jobs";
import {
	addMount,
	listMounts,
	mountInput,
	removeMountsForOwner,
	updateMount,
} from "../lib/mounts";
import {
	type Access,
	canAccessService,
	grantCreatedAccess,
	requireEnvironmentPermission,
	requirePermission,
	requireServiceCreation,
	requireServicePermission,
} from "../lib/permissions";
import { deleteSecret, putSecret, readSecret } from "../lib/secrets";
import { assertDeployed } from "../lib/serviceActivity";
import {
	actorOf,
	mountDetails,
	recordEnvEvent,
	recordOwnerEvent,
	recordServiceEvent,
	recordSettingsEvents,
} from "../lib/serviceEvents";
import { resourceSettings, swarmSettings } from "../lib/serviceSettings";
import { assertSwarmSettingsAllowed } from "../lib/swarmPolicy";
import { boundedAppNames, volumesToRemove } from "../lib/volumeRefs";
import { assertPanelHostTarget } from "../platform/deployTargets";
import { deletingTogether } from "../tables/core";
import { databaseEngine } from "../tables/databases";
import {
	APP_NAME_REGEX,
	ENGINES,
	ENV_KIND,
	type Engine,
	groupFor,
	LIBSQL_ADMIN_PORT,
	LIBSQL_GRPC_PORT,
	loadDatabase,
	PASSWORD_KIND,
	partitionOf,
	ROOT_PASSWORD_KIND,
	randomPassword,
	recentDeployments,
	validateIdentifier,
	validatePassword,
	validatePort,
} from "./lib";

const MAX_LIST = 500;
const MAX_ENV_LENGTH = 256 * 1024;
const MAX_DEPLOYMENTS = 50;
const CANCEL_SCAN = 50;
const CASCADE_BATCH = 50;

const encrypted = v.object({ iv: v.string(), ciphertext: v.string() });

const engineFields = {
	databaseName: v.optional(v.string()),
	databaseUser: v.optional(v.string()),
	replicaSets: v.optional(v.boolean()),
	sqldNode: v.optional(v.union(v.literal("primary"), v.literal("replica"))),
	sqldPrimaryUrl: v.optional(v.string()),
	enableNamespaces: v.optional(v.boolean()),
};

const createArgs = {
	environmentId: v.id("environments"),
	serverId: v.optional(v.id("servers")),
	engine: databaseEngine,
	name: v.string(),
	appName: v.optional(v.string()),
	description: v.optional(v.string()),
	dockerImage: v.optional(v.string()),
	...engineFields,
};

const mountOwner = (databaseId: Id<"databases">) => ({
	kind: "database",
	id: databaseId,
});

const checkEngineFields = (
	engine: Engine,
	fields: {
		databaseName?: string;
		databaseUser?: string;
		sqldNode?: "primary" | "replica";
		sqldPrimaryUrl?: string;
	},
) => {
	const info = ENGINES[engine];
	if (info.hasDatabaseName && fields.databaseName !== undefined) {
		validateIdentifier(fields.databaseName, "Database name");
	}
	if (info.hasUser && fields.databaseUser !== undefined) {
		validateIdentifier(fields.databaseUser, "Database user");
	}
	if (engine === "libsql" && fields.sqldNode === "replica") {
		if (!fields.sqldPrimaryUrl?.trim()) {
			throw new ConvexError("A replica needs the primary's URL");
		}
	}
};

const assertEnvironment = async (
	ctx: QueryCtx,
	environmentId: Id<"environments">,
) => {
	const environment = await ctx.db.get("environments", environmentId);
	if (!environment) throw new ConvexError("Environment not found");
	return environment;
};

const assertServer = async (
	ctx: QueryCtx,
	organizationId: string,
	serverId: Id<"servers"> | undefined,
) => {
	if (!serverId) return await assertPanelHostTarget(ctx, organizationId);
	const server = await ctx.db.get("servers", serverId);
	if (!server || server.organizationId !== organizationId) {
		throw new ConvexError("Server not found");
	}
};

export const create = action({
	args: {
		...createArgs,
		databasePassword: v.optional(v.string()),
		databaseRootPassword: v.optional(v.string()),
	},
	handler: async (
		ctx,
		{ databasePassword, databaseRootPassword, ...args },
	): Promise<Id<"databases">> => {
		if (databasePassword) validatePassword(databasePassword);
		if (databaseRootPassword) {
			validatePassword(databaseRootPassword, "Root password");
		}
		const info = ENGINES[args.engine];
		return await ctx.runMutation(internal.databases.databases.insert, {
			...args,
			appNameSuffix: randomPassword(6).toLowerCase(),
			password: await encryptSecret(databasePassword || randomPassword()),
			rootPassword: info.hasRootPassword
				? await encryptSecret(databaseRootPassword || randomPassword())
				: undefined,
		});
	},
});

export const insert = internalMutation({
	args: {
		...createArgs,
		appNameSuffix: v.string(),
		password: encrypted,
		rootPassword: v.optional(encrypted),
	},
	handler: async (ctx, args) => {
		const environment = await assertEnvironment(ctx, args.environmentId);
		const organizationId = environment.organizationId;
		const access = await requireServiceCreation(ctx, environment);
		await assertServer(ctx, organizationId, args.serverId);
		const info = ENGINES[args.engine];
		const name = args.name.trim();
		if (!name) throw new ConvexError("Name is required");
		const base = args.appName?.trim().toLowerCase();
		if (base !== undefined && base !== "" && !APP_NAME_REGEX.test(base)) {
			throw new ConvexError(
				"App name may only contain letters, digits, '.', '_' and '-'",
			);
		}
		const appName = `${base || args.engine}-${args.appNameSuffix}`;
		if (await isAppNameInUse(ctx, appName)) {
			throw new ConvexError("Service with this 'AppName' already exists");
		}
		const databaseName = info.hasDatabaseName
			? args.databaseName?.trim() || args.engine
			: undefined;
		const databaseUser = info.hasUser
			? args.databaseUser?.trim() || args.engine
			: undefined;
		checkEngineFields(args.engine, { ...args, databaseName, databaseUser });
		const dockerImage = args.dockerImage?.trim() || info.image;
		const databaseId = await ctx.db.insert("databases", {
			organizationId,
			projectId: environment.projectId,
			environmentId: args.environmentId,
			serverId: args.serverId,
			engine: args.engine,
			name,
			appName,
			description: args.description,
			dockerImage,
			databaseName,
			databaseUser,
			replicas: 1,
			replicaSets: args.engine === "mongo" ? !!args.replicaSets : undefined,
			sqldNode:
				args.engine === "libsql" ? (args.sqldNode ?? "primary") : undefined,
			sqldPrimaryUrl:
				args.engine === "libsql" ? args.sqldPrimaryUrl?.trim() : undefined,
			enableNamespaces:
				args.engine === "libsql" ? !!args.enableNamespaces : undefined,
			status: "idle",
		});
		await putSecret(ctx, {
			organizationId,
			kind: PASSWORD_KIND,
			ownerId: databaseId,
			...args.password,
		});
		if (args.rootPassword) {
			await putSecret(ctx, {
				organizationId,
				kind: ROOT_PASSWORD_KIND,
				ownerId: databaseId,
				...args.rootPassword,
			});
		}
		await addMount(ctx, organizationId, mountOwner(databaseId), {
			type: "volume",
			volumeName: `${appName}-data`,
			mountPath: info.mountPath(dockerImage),
		});
		await grantCreatedAccess(ctx, access, organizationId, {
			serviceId: databaseId,
		});
		await recordServiceEvent(
			ctx,
			"database",
			{ _id: databaseId, organizationId },
			"lifecycle.created",
			access.userId,
		);
		return databaseId;
	},
});

export const list = query({
	args: { environmentId: v.id("environments") },
	handler: async (ctx, { environmentId }) => {
		const environment = await ctx.db.get("environments", environmentId);
		if (!environment) return [];
		const access = await requirePermission(
			ctx,
			environment.organizationId,
			"service",
			"read",
		);
		const rows = await ctx.db
			.query("databases")
			.withIndex("by_environmentId", (q) =>
				q.eq("environmentId", environmentId),
			)
			.take(MAX_LIST);
		return rows.filter((row) => canAccessService(access, row._id));
	},
});

export const listForOrganization = query({
	args: { organizationId: v.string(), engine: v.optional(databaseEngine) },
	handler: async (ctx, { organizationId, engine }) => {
		const access = await requirePermission(
			ctx,
			organizationId,
			"service",
			"read",
		);
		const rows = await ctx.db
			.query("databases")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_LIST);
		return rows.filter(
			(row) =>
				canAccessService(access, row._id) && (!engine || row.engine === engine),
		);
	},
});

export const get = query({
	args: { databaseId: v.id("databases") },
	handler: async (ctx, { databaseId }) => {
		const database = await ctx.db.get("databases", databaseId);
		if (!database) return null;
		await requireServicePermission(ctx, database, "service", "read");
		return database;
	},
});

const externalHost = async (ctx: QueryCtx, database: Doc<"databases">) => {
	if (database.serverId) {
		const server = await ctx.db.get("servers", database.serverId);
		return server?.ipAddress ?? null;
	}
	const settings = await ctx.db
		.query("webServerSettings")
		.withIndex("by_key", (q) => q.eq("key", "instance"))
		.unique();
	return settings?.serverIp ?? null;
};

const MASK = "********";

const connectionUrl = (
	database: Doc<"databases">,
	host: string,
	port: number,
	password: string,
) => {
	const scheme = ENGINES[database.engine].scheme;
	const secret = encodeURIComponent(password);
	switch (database.engine) {
		case "postgres":
		case "mysql":
		case "mariadb":
			return `${scheme}://${database.databaseUser}:${secret}@${host}:${port}/${database.databaseName}`;
		case "mongo":
			return `${scheme}://${database.databaseUser}:${secret}@${host}:${port}`;
		case "redis":
			return `${scheme}://default:${secret}@${host}:${port}`;
		case "libsql":
			return `${scheme}://${database.databaseUser}:${secret}@${host}:${port}`;
	}
};

// Hosts, ports and connection URLs. Passwords are only included for admins:
// only privileged users see database credentials.
export const connection = query({
	args: { databaseId: v.id("databases") },
	handler: async (ctx, { databaseId }) => {
		const database = await ctx.db.get("databases", databaseId);
		if (!database) return null;
		const { role } = await requireServicePermission(
			ctx,
			database,
			"service",
			"read",
		);
		const showSecrets = role === "admin" || role === "owner";
		const password = showSecrets
			? ((await readSecret(ctx, PASSWORD_KIND, databaseId)) ?? "")
			: undefined;
		const rootPassword =
			showSecrets && ENGINES[database.engine].hasRootPassword
				? ((await readSecret(ctx, ROOT_PASSWORD_KIND, databaseId)) ?? "")
				: undefined;
		const port = ENGINES[database.engine].port;
		const host = await externalHost(ctx, database);
		const shown = password ?? MASK;
		return {
			engine: database.engine,
			databaseName: database.databaseName ?? null,
			databaseUser: database.databaseUser ?? null,
			password: password ?? null,
			rootPassword: rootPassword ?? null,
			internalHost: database.appName,
			internalPort: port,
			internalUrl: connectionUrl(database, database.appName, port, shown),
			externalHost: host,
			externalPort: database.externalPort ?? null,
			externalUrl:
				host && database.externalPort
					? connectionUrl(database, host, database.externalPort, shown)
					: null,
			...(database.engine === "libsql"
				? {
						internalGRPCPort: LIBSQL_GRPC_PORT,
						internalAdminPort: LIBSQL_ADMIN_PORT,
						externalGRPCPort: database.externalGRPCPort ?? null,
						externalAdminPort: database.externalAdminPort ?? null,
					}
				: {}),
		};
	},
});

// Everything a database's page shows: the row,
// its server, environment and project names, its mounts and, for admins,
// its passwords.
export const one = query({
	args: { databaseId: v.id("databases") },
	handler: async (ctx, { databaseId }) => {
		const database = await ctx.db.get("databases", databaseId);
		if (!database) return null;
		const { role } = await requireServicePermission(
			ctx,
			database,
			"service",
			"read",
		);
		const showSecrets = role === "admin" || role === "owner";
		const [server, environment, project, mounts] = await Promise.all([
			database.serverId ? ctx.db.get("servers", database.serverId) : null,
			ctx.db.get("environments", database.environmentId),
			ctx.db.get("projects", database.projectId),
			listMounts(ctx, mountOwner(databaseId)),
		]);
		return {
			...database,
			password: showSecrets
				? ((await readSecret(ctx, PASSWORD_KIND, databaseId)) ?? "")
				: null,
			rootPassword:
				showSecrets && ENGINES[database.engine].hasRootPassword
					? ((await readSecret(ctx, ROOT_PASSWORD_KIND, databaseId)) ?? "")
					: null,
			server: server
				? { _id: server._id, name: server.name, ipAddress: server.ipAddress }
				: null,
			serverIp: await externalHost(ctx, database),
			environment: environment
				? { _id: environment._id, name: environment.name }
				: null,
			project: project ? { _id: project._id, name: project.name } : null,
			mounts,
		};
	},
});

const clearable = <T extends import("convex/values").Validator<any, any, any>>(
	validator: T,
) => v.optional(v.union(validator, v.null()));

export const update = mutation({
	args: {
		databaseId: v.id("databases"),
		name: v.optional(v.string()),
		description: clearable(v.string()),
		dockerImage: v.optional(v.string()),
		command: clearable(v.string()),
		args: clearable(v.array(v.string())),
		replicas: v.optional(v.number()),
		...engineFields,
		sqldPrimaryUrl: clearable(v.string()),
	},
	handler: async (ctx, { databaseId, ...fields }) => {
		const { database, userId } = await loadDatabase(
			ctx,
			databaseId,
			"service",
			"create",
		);
		const patch: Partial<Doc<"databases">> = {};
		if (fields.name !== undefined) {
			const name = fields.name.trim();
			if (!name) throw new ConvexError("Name is required");
			patch.name = name;
		}
		if (fields.dockerImage !== undefined) {
			const image = fields.dockerImage.trim();
			if (!image) throw new ConvexError("Docker image is required");
			patch.dockerImage = image;
		}
		if (fields.replicas !== undefined) {
			if (!Number.isInteger(fields.replicas) || fields.replicas < 0) {
				throw new ConvexError("Replicas must be a whole number");
			}
			patch.replicas = fields.replicas;
		}
		for (const key of ["description", "command", "args"] as const) {
			const value = fields[key];
			if (value !== undefined) {
				(patch as Record<string, unknown>)[key] = value ?? undefined;
			}
		}
		const info = ENGINES[database.engine];
		if (info.hasDatabaseName && fields.databaseName !== undefined) {
			patch.databaseName = fields.databaseName.trim();
		}
		if (info.hasUser && fields.databaseUser !== undefined) {
			patch.databaseUser = fields.databaseUser.trim();
		}
		if (database.engine === "mongo" && fields.replicaSets !== undefined) {
			patch.replicaSets = fields.replicaSets;
		}
		if (database.engine === "libsql") {
			if (fields.sqldNode !== undefined) patch.sqldNode = fields.sqldNode;
			if (fields.sqldPrimaryUrl !== undefined) {
				patch.sqldPrimaryUrl = fields.sqldPrimaryUrl?.trim() || undefined;
			}
			if (fields.enableNamespaces !== undefined) {
				patch.enableNamespaces = fields.enableNamespaces;
			}
		}
		const merged = { ...database, ...patch };
		checkEngineFields(database.engine, {
			databaseName: patch.databaseName,
			databaseUser: patch.databaseUser,
			sqldNode: merged.sqldNode,
			sqldPrimaryUrl: merged.sqldPrimaryUrl,
		});
		await ctx.db.patch("databases", databaseId, patch);
		await recordSettingsEvents(
			ctx,
			"database",
			database,
			userId,
			Object.keys(patch),
			{ newName: patch.name, areas: DATABASE_SETTING_AREAS },
		);
	},
});

// Sets the extra networks and whether the service leaves
// panara-cloud-network; applied on the next deploy.
export const updateNetworks = mutation({
	args: {
		databaseId: v.id("databases"),
		networkIds: v.array(v.id("networks")),
		detachPanaraCloudNetwork: v.boolean(),
	},
	handler: async (
		ctx,
		{ databaseId, networkIds, detachPanaraCloudNetwork },
	) => {
		const { database, userId } = await loadDatabase(
			ctx,
			databaseId,
			"service",
			"create",
		);
		const valid = await validateServiceNetworks(
			ctx,
			database.organizationId,
			database.serverId,
			networkIds,
			detachPanaraCloudNetwork,
		);
		await ctx.db.patch("databases", databaseId, {
			networkIds: valid.length > 0 ? valid : undefined,
			detachPanaraCloudNetwork: detachPanaraCloudNetwork || undefined,
		});
		await recordServiceEvent(
			ctx,
			"database",
			database,
			"config.networks",
			userId,
		);
	},
});

// Replaces all swarm and resource settings at once, as the settings form
// submits them together. Takes effect on the next deploy.
export const updateServiceSettings = mutation({
	args: {
		databaseId: v.id("databases"),
		...swarmSettings,
		...resourceSettings,
	},
	handler: async (ctx, { databaseId, ...settings }) => {
		const { database, userId } = await loadDatabase(
			ctx,
			databaseId,
			"service",
			"create",
		);
		await assertSwarmSettingsAllowed(
			ctx,
			database.organizationId,
			database.serverId,
			settings,
		);
		await recordSettingsEvents(
			ctx,
			"database",
			database,
			userId,
			Object.keys(settings),
		);
		const cleared = Object.fromEntries(
			[...Object.keys(swarmSettings), ...Object.keys(resourceSettings)].map(
				(key) => [key, undefined],
			),
		);
		await ctx.db.patch("databases", databaseId, { ...cleared, ...settings });
	},
});

export const move = mutation({
	args: {
		databaseId: v.id("databases"),
		targetEnvironmentId: v.id("environments"),
	},
	handler: async (ctx, { databaseId, targetEnvironmentId }) => {
		const { database, userId } = await loadDatabase(
			ctx,
			databaseId,
			"service",
			"create",
		);
		const target = await ctx.db.get("environments", targetEnvironmentId);
		if (!target || target.organizationId !== database.organizationId) {
			throw new ConvexError("Environment not found");
		}
		await requireEnvironmentPermission(ctx, target, "environment", "read");
		await ctx.db.patch("databases", databaseId, {
			environmentId: target._id,
			projectId: target.projectId,
		});
		await recordServiceEvent(
			ctx,
			"database",
			database,
			"config.moved",
			userId,
			{ to: target.name },
		);
	},
});

export const getEnv = query({
	args: { databaseId: v.id("databases") },
	handler: async (ctx, { databaseId }) => {
		const database = await ctx.db.get("databases", databaseId);
		if (!database) return null;
		await requireServicePermission(ctx, database, "envVars", "read");
		return (await readSecret(ctx, ENV_KIND, databaseId)) ?? "";
	},
});

export const setEnv = action({
	args: { databaseId: v.id("databases"), env: v.string() },
	handler: async (ctx, { databaseId, env }) => {
		if (env.length > MAX_ENV_LENGTH) {
			throw new ConvexError("Environment is too large");
		}
		await ctx.runMutation(internal.databases.databases.storeEnv, {
			databaseId,
			...(await encryptSecret(env)),
		});
	},
});

export const storeEnv = internalMutation({
	args: { databaseId: v.id("databases"), ...encrypted.fields },
	handler: async (ctx, { databaseId, iv, ciphertext }) => {
		const { database, userId } = await loadDatabase(
			ctx,
			databaseId,
			"envVars",
			"write",
		);
		await recordEnvEvent(ctx, "database", database, userId, [
			{ kind: ENV_KIND, label: "env", next: { iv, ciphertext } },
		]);
		await putSecret(ctx, {
			organizationId: database.organizationId,
			kind: ENV_KIND,
			ownerId: databaseId,
			iv,
			ciphertext,
		});
	},
});

const enqueueDatabaseJob = async (
	ctx: MutationCtx,
	database: Doc<"databases">,
	spec: JobSpec,
	options: { idempotent: boolean; requestedBy: string; title?: string },
): Promise<Id<"jobs">> => {
	const jobId = await enqueueJob(ctx, {
		organizationId: database.organizationId,
		partition: partitionOf(database.serverId),
		group: groupFor(database.engine, database._id),
		spec,
		idempotent: options.idempotent,
		// Databases pull an image and update a service; they never build, so
		// they don't wait behind application builds for a build slot.
		usesBuildSlot: false,
		requestedBy: options.requestedBy,
	});
	if (options.title) {
		await ctx.db.insert("deployments", {
			organizationId: database.organizationId,
			jobId,
			target: { kind: "database", id: database._id },
			title: options.title,
			imageRef: database.dockerImage,
		});
	}
	return jobId;
};

const LIFECYCLE_EVENTS = {
	"databases.deploy": undefined,
	"databases.rebuild": undefined,
	"databases.start": "lifecycle.start",
	"databases.stop": "lifecycle.stop",
	"databases.reload": "lifecycle.reload",
} as const;

const DATABASE_SETTING_AREAS = {
	dockerImage: "config.source",
	databaseName: "config.advanced",
	databaseUser: "config.advanced",
	replicaSets: "config.advanced",
	sqldNode: "config.advanced",
	sqldPrimaryUrl: "config.advanced",
	enableNamespaces: "config.advanced",
} as const;

type LifecycleKind =
	| "databases.deploy"
	| "databases.start"
	| "databases.stop"
	| "databases.reload"
	| "databases.rebuild";

const lifecycleHandler =
	(kind: LifecycleKind, options: { idempotent: boolean; title?: string }) =>
	async (
		ctx: MutationCtx,
		{ databaseId }: { databaseId: Id<"databases"> },
	): Promise<Id<"jobs">> => {
		const { database, userId } = await loadDatabase(
			ctx,
			databaseId,
			"deployment",
			"create",
		);
		const lifecycleType = LIFECYCLE_EVENTS[kind];
		if (lifecycleType) {
			await assertDeployed(
				ctx,
				database,
				groupFor(database.engine, database._id),
			);
		}
		if (lifecycleType)
			await recordServiceEvent(
				ctx,
				"database",
				database,
				lifecycleType,
				userId,
			);
		return await enqueueDatabaseJob(
			ctx,
			database,
			{ kind, databaseId },
			{ ...options, requestedBy: userId },
		);
	};

const lifecycle = (
	kind: LifecycleKind,
	options: { idempotent: boolean; title?: string },
) =>
	mutation({
		args: { databaseId: v.id("databases") },
		handler: lifecycleHandler(kind, options),
	});

// Exported so `serviceEvents.applyPending` starts the same job with the same
// permission checks.
export const startDeploy = lifecycleHandler("databases.deploy", {
	idempotent: true,
	title: "Deploy",
});
export const deploy = mutation({
	args: { databaseId: v.id("databases") },
	handler: startDeploy,
});
export const start = lifecycle("databases.start", { idempotent: true });
export const stop = lifecycle("databases.stop", { idempotent: true });
export const reload = lifecycle("databases.reload", { idempotent: true });
// Rebuild: deletes the data volumes and recreates the service.
// Not idempotent: a retry after a crash must not wipe data restored since.
export const rebuild = lifecycle("databases.rebuild", {
	idempotent: false,
	title: "Rebuild",
});

export const assertPortsFree = async (
	ctx: QueryCtx,
	database: Doc<"databases">,
	ports: number[],
	serverId: Id<"servers"> | undefined = database.serverId,
) => {
	if (new Set(ports).size !== ports.length) {
		throw new ConvexError("External ports must be different");
	}
	const siblings = await ctx.db
		.query("databases")
		.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
		.take(1000);
	for (const port of ports) {
		const clash = siblings.find(
			(other) =>
				other._id !== database._id &&
				[
					other.externalPort,
					other.externalGRPCPort,
					other.externalAdminPort,
				].includes(port),
		);
		if (clash) {
			throw new ConvexError(`Port ${port} is already used by ${clash.name}`);
		}
		const published = await ctx.db
			.query("ports")
			.withIndex("by_serverId_and_publishedPort", (q) =>
				q.eq("serverId", serverId).eq("publishedPort", port),
			)
			.first();
		if (published) {
			throw new ConvexError(`Port ${port} is already published on this server`);
		}
	}
};

// Publishes (or unpublishes, with null) the database on the host and
// redeploys it.
export const saveExternalPort = mutation({
	args: {
		databaseId: v.id("databases"),
		externalPort: v.union(v.number(), v.null()),
		externalGRPCPort: v.optional(v.union(v.number(), v.null())),
		externalAdminPort: v.optional(v.union(v.number(), v.null())),
	},
	handler: async (ctx, { databaseId, ...ports }): Promise<Id<"jobs">> => {
		const { database, userId } = await loadDatabase(
			ctx,
			databaseId,
			"service",
			"create",
		);
		const next = {
			externalPort: ports.externalPort ?? undefined,
			externalGRPCPort:
				database.engine === "libsql"
					? ports.externalGRPCPort === undefined
						? database.externalGRPCPort
						: (ports.externalGRPCPort ?? undefined)
					: undefined,
			externalAdminPort:
				database.engine === "libsql"
					? ports.externalAdminPort === undefined
						? database.externalAdminPort
						: (ports.externalAdminPort ?? undefined)
					: undefined,
		};
		validatePort(next.externalPort, "External port");
		validatePort(next.externalGRPCPort, "External gRPC port");
		validatePort(next.externalAdminPort, "External admin port");
		await assertPortsFree(
			ctx,
			database,
			[next.externalPort, next.externalGRPCPort, next.externalAdminPort].filter(
				(port): port is number => port !== undefined,
			),
		);
		await ctx.db.patch("databases", databaseId, next);
		await recordServiceEvent(
			ctx,
			"database",
			database,
			"config.externalPort",
			userId,
			{
				port: next.externalPort,
				action: next.externalPort === undefined ? "remove" : "update",
			},
		);
		return await enqueueDatabaseJob(
			ctx,
			{ ...database, ...next },
			{ kind: "databases.deploy", databaseId },
			{ idempotent: true, requestedBy: userId, title: "Deploy" },
		);
	},
});

export const deployments = query({
	args: { databaseId: v.id("databases"), limit: v.optional(v.number()) },
	handler: async (ctx, { databaseId, limit }) => {
		const database = await ctx.db.get("databases", databaseId);
		if (!database) return [];
		await requireServicePermission(ctx, database, "deployment", "read");
		const take = Math.min(Math.max(limit ?? 20, 1), MAX_DEPLOYMENTS);
		return await recentDeployments(
			ctx,
			{ kind: "database", id: databaseId },
			take,
		);
	},
});

export const mounts = query({
	args: { databaseId: v.id("databases") },
	handler: async (ctx, { databaseId }) => {
		const database = await ctx.db.get("databases", databaseId);
		if (!database) return [];
		await requireServicePermission(ctx, database, "volume", "read");
		return await listMounts(ctx, mountOwner(databaseId));
	},
});

export const addDatabaseMount = mutation({
	args: { databaseId: v.id("databases"), mount: mountInput },
	handler: async (ctx, { databaseId, mount }) => {
		const { database, userId } = await loadDatabase(
			ctx,
			databaseId,
			"volume",
			"create",
		);
		await recordServiceEvent(
			ctx,
			"database",
			database,
			"config.mounts",
			userId,
			mountDetails(mount, "create"),
		);
		return await addMount(
			ctx,
			database.organizationId,
			mountOwner(databaseId),
			mount,
		);
	},
});

const loadOwnedMount = async (
	ctx: QueryCtx,
	mountId: Id<"mounts">,
	action: "create" | "delete",
) => {
	const mount = await ctx.db.get("mounts", mountId);
	const databaseId =
		mount?.owner.kind === "database"
			? ctx.db.normalizeId("databases", mount.owner.id)
			: null;
	if (!mount || !databaseId) throw new ConvexError("Mount not found");
	await loadDatabase(ctx, databaseId, "volume", action);
	return mount;
};

export const updateDatabaseMount = mutation({
	args: { mountId: v.id("mounts"), mount: mountInput },
	handler: async (ctx, { mountId, mount }) => {
		const current = await loadOwnedMount(ctx, mountId, "create");
		await updateMount(ctx, mountId, mount);
		await recordOwnerEvent(
			ctx,
			current.owner,
			current.organizationId,
			"config.mounts",
			await actorOf(ctx),
			mountDetails(mount, "update"),
		);
	},
});

export const removeDatabaseMount = mutation({
	args: { mountId: v.id("mounts") },
	handler: async (ctx, { mountId }) => {
		const mount = await loadOwnedMount(ctx, mountId, "delete");
		await ctx.db.delete("mounts", mountId);
		await recordOwnerEvent(
			ctx,
			mount.owner,
			mount.organizationId,
			"config.mounts",
			await actorOf(ctx),
			mountDetails(mount, "remove"),
		);
	},
});

const cancelQueuedJobs = async (ctx: MutationCtx, group: string) => {
	const queued = await ctx.db
		.query("jobs")
		.withIndex("by_group_and_status", (q) =>
			q.eq("group", group).eq("status", "queued"),
		)
		.take(CANCEL_SCAN);
	for (const job of queued) {
		await ctx.db.patch("jobs", job._id, {
			status: "cancelled",
			cancelRequested: true,
			finishedAt: Date.now(),
		});
	}
};

// Deletes the row and everything hanging off it, then queues removal of the
// swarm service (and, if asked, its data volumes) on the host.
const destroyDatabase = async (
	ctx: MutationCtx,
	database: Doc<"databases">,
	options: {
		// Set when the service's volumes are deleted with it.
		volumes?: { access: Access; deletingTogether: string[] };
		requestedBy?: string;
		onHost: boolean;
	},
): Promise<Id<"jobs"> | null> => {
	const owner = mountOwner(database._id);
	const { volumeNames, keptVolumes } = options.volumes
		? await volumesToRemove(ctx, database, owner, options.volumes)
		: { volumeNames: [], keptVolumes: [] };
	const group = groupFor(database.engine, database._id);
	await cancelQueuedJobs(ctx, group);
	await requestCancelRunning(ctx, group, [
		"databases.deploy",
		"databases.rebuild",
	]);
	await ctx.db.delete("databases", database._id);
	await removeMountsForOwner(ctx, owner);
	for (const kind of [PASSWORD_KIND, ROOT_PASSWORD_KIND, ENV_KIND]) {
		await deleteSecret(ctx, kind, database._id);
	}
	const ownerRef = { kind: "database" as const, id: database._id };
	await ctx.scheduler.runAfter(
		0,
		internal.databases.backups.removeForOwner,
		ownerRef,
	);
	await ctx.scheduler.runAfter(
		0,
		internal.databases.volumeBackups.removeForOwner,
		ownerRef,
	);
	await ctx.scheduler.runAfter(0, internal.platform.schedules.removeForTarget, {
		targetId: database._id,
	});
	if (!options.onHost) return null;
	return await enqueueJob(ctx, {
		organizationId: database.organizationId,
		partition: partitionOf(database.serverId),
		group,
		spec: {
			kind: "databases.remove",
			appName: database.appName,
			volumeNames,
			...(keptVolumes.length > 0 ? { keptVolumes } : {}),
			...(volumeNames.length > 0 && options.volumes?.deletingTogether.length
				? { deletingTogether: options.volumes.deletingTogether }
				: {}),
		},
		idempotent: true,
		usesBuildSlot: false,
		requestedBy: options.requestedBy,
	});
};

export const remove = mutation({
	args: {
		databaseId: v.id("databases"),
		deleteVolumes: v.optional(v.boolean()),
		deletingTogether,
	},
	handler: async (ctx, { databaseId, deleteVolumes, deletingTogether }) => {
		const database = await ctx.db.get("databases", databaseId);
		if (!database) return null;
		const access = await requireServicePermission(
			ctx,
			database,
			"service",
			"delete",
		);
		return await destroyDatabase(ctx, database, {
			volumes: deleteVolumes
				? { access, deletingTogether: boundedAppNames(deletingTogether) }
				: undefined,
			requestedBy: access.userId,
			onHost: true,
		});
	},
});

// For the coordinator: cascade when an environment (or its project) is
// deleted. Services are removed from their hosts; volumes are kept.
export const removeForEnvironment = internalMutation({
	args: { environmentId: v.id("environments") },
	handler: async (ctx, { environmentId }) => {
		const batch = await ctx.db
			.query("databases")
			.withIndex("by_environmentId", (q) =>
				q.eq("environmentId", environmentId),
			)
			.take(CASCADE_BATCH);
		for (const database of batch) {
			await destroyDatabase(ctx, database, {
				onHost: true,
			});
		}
		if (batch.length === CASCADE_BATCH) {
			await ctx.scheduler.runAfter(
				0,
				internal.databases.databases.removeForEnvironment,
				{ environmentId },
			);
		}
	},
});

// For the coordinator: cascade when a server is deleted. The host is gone
// (or no longer ours), so nothing is queued there.
export const removeForServer = internalMutation({
	args: { serverId: v.id("servers") },
	handler: async (ctx, { serverId }) => {
		const batch = await ctx.db
			.query("databases")
			.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
			.take(CASCADE_BATCH);
		for (const database of batch) {
			await destroyDatabase(ctx, database, {
				onHost: false,
			});
		}
		if (batch.length === CASCADE_BATCH) {
			await ctx.scheduler.runAfter(
				0,
				internal.databases.databases.removeForServer,
				{ serverId },
			);
		}
	},
});
