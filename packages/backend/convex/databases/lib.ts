import { ConvexError, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
	type Access,
	type Action,
	type Resource,
	requireServicePermission,
} from "../lib/permissions";
import { parseSchedule } from "../platform/lib/cron";
import { LOCAL_PARTITION } from "../tables/core";
import type {
	backupEngine,
	backupOwner,
	databaseEngine,
	volumeOwner,
} from "../tables/databases";

export type Engine = Infer<typeof databaseEngine>;
export type BackupEngine = Infer<typeof backupEngine>;
export type BackupOwner = Infer<typeof backupOwner>;
export type VolumeOwner = Infer<typeof volumeOwner>;

export const PASSWORD_KIND = "databases.password";
export const ROOT_PASSWORD_KIND = "databases.rootPassword";
export const ENV_KIND = "databases.env";
export const DESTINATION_SECRET_KIND = "databases.destinationSecret";
export const DESTINATION_DRAFT_KIND = "databases.destinationDraft";
export const BACKUP_PASSWORD_KIND = "databases.backupPassword";
// A requested password change, until the container accepted it (ownerId:
// the databases.changePassword job id).
export const PENDING_PASSWORD_KIND = "databases.pendingPassword";
// The password typed into a compose restore form (ownerId: the
// databases.restore job id), removed when the restore ends.
export const RESTORE_PASSWORD_KIND = "databases.restorePassword";

export const APP_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;
export const COMPOSE_SERVICE_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BACKUP_PREFIX_REGEX = /^[A-Za-z0-9._/-]*$/;

// Prefixes and compose service names become backup paths and appear in the
// agent's shell scripts.
export const validateBackupPrefix = (prefix: string) => {
	const value = prefix.trim();
	if (
		value.length > 256 ||
		!BACKUP_PREFIX_REGEX.test(value) ||
		value.split("/").includes("..")
	) {
		throw new ConvexError(
			"The prefix may only contain letters, digits, '.', '_', '-' and '/' (no '..')",
		);
	}
};

export const validateComposeServiceName = (serviceName: string | undefined) => {
	const value = serviceName?.trim() ?? "";
	if (!value) throw new ConvexError("Service name is required");
	if (!COMPOSE_SERVICE_REGEX.test(value)) {
		throw new ConvexError(
			"The service name may only contain letters, digits, '.', '_' and '-'",
		);
	}
};

export const VOLUME_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
export const DATABASE_PASSWORD_REGEX =
	/^[a-zA-Z0-9@#%^&*()_+\-=[\]{}|;:,.<>?~`]*$/;
// Database names and users end up in connection strings and dump commands.
const IDENTIFIER_REGEX = /^[a-zA-Z0-9_][a-zA-Z0-9_.$-]{0,62}$/;

type EngineInfo = {
	image: string;
	port: number;
	hasDatabaseName: boolean;
	hasUser: boolean;
	hasRootPassword: boolean;
	mountPath: (image: string) => string;
	scheme: string;
};

// Postgres 18+ images keep PGDATA under /var/lib/postgresql/<major>/docker.
export const postgresMountPath = (image: string) => {
	const match = image.match(/postgres:(\d+)/);
	const version = match?.[1] ? Number.parseInt(match[1], 10) : 0;
	return version >= 18
		? `/var/lib/postgresql/${version}/docker`
		: "/var/lib/postgresql/data";
};

export const ENGINES: Record<Engine, EngineInfo> = {
	postgres: {
		image: "postgres:18",
		port: 5432,
		hasDatabaseName: true,
		hasUser: true,
		hasRootPassword: false,
		mountPath: postgresMountPath,
		scheme: "postgresql",
	},
	mysql: {
		image: "mysql:8",
		port: 3306,
		hasDatabaseName: true,
		hasUser: true,
		hasRootPassword: true,
		mountPath: () => "/var/lib/mysql",
		scheme: "mysql",
	},
	mariadb: {
		image: "mariadb:11",
		port: 3306,
		hasDatabaseName: true,
		hasUser: true,
		hasRootPassword: true,
		mountPath: () => "/var/lib/mysql",
		scheme: "mariadb",
	},
	mongo: {
		image: "mongo:8",
		port: 27017,
		hasDatabaseName: false,
		hasUser: true,
		hasRootPassword: false,
		mountPath: () => "/data/db",
		scheme: "mongodb",
	},
	redis: {
		image: "redis:8",
		port: 6379,
		hasDatabaseName: false,
		hasUser: false,
		hasRootPassword: false,
		mountPath: () => "/data",
		scheme: "redis",
	},
	libsql: {
		image: "ghcr.io/tursodatabase/libsql-server:v0.24.32",
		port: 8080,
		hasDatabaseName: false,
		hasUser: true,
		hasRootPassword: false,
		mountPath: () => "/var/lib/sqld",
		scheme: "http",
	},
};

export const LIBSQL_GRPC_PORT = 5001;
export const LIBSQL_ADMIN_PORT = 5000;

export const groupFor = (engine: string, id: string) => `${engine}:${id}`;

export const partitionOf = (serverId: string | undefined) =>
	serverId ?? LOCAL_PARTITION;

export const validateIdentifier = (value: string, label: string) => {
	if (!IDENTIFIER_REGEX.test(value)) {
		throw new ConvexError(
			`${label} may only contain letters, digits, '_', '.', '$' and '-'`,
		);
	}
};

export const validatePassword = (value: string, label = "Password") => {
	if (!value || !DATABASE_PASSWORD_REGEX.test(value)) {
		throw new ConvexError(
			`${label} contains characters that are not allowed in a database password`,
		);
	}
};

export const validatePort = (port: number | undefined, label: string) => {
	if (port === undefined) return;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new ConvexError(`${label} must be between 1 and 65535`);
	}
};

export const validateSchedule = (cronExpression: string, timezone?: string) => {
	try {
		parseSchedule(cronExpression, timezone);
	} catch (error) {
		throw new ConvexError(error instanceof Error ? error.message : "Invalid");
	}
};

export const validateKeepLatest = (count: number | undefined) => {
	if (count === undefined) return;
	if (!Number.isInteger(count) || count < 0 || count > 1000) {
		throw new ConvexError("Keep latest must be a whole number up to 1000");
	}
};

export const normalizeS3Path = (prefix: string) => {
	const normalized = prefix.trim().replace(/^\/+|\/+$/g, "");
	return normalized ? `${normalized}/` : "";
};

// Backups of compose services live under "<appName>_<serviceName>/".
export const backupFolder = (
	appName: string,
	serviceName: string | undefined,
	prefix: string,
) =>
	`${serviceName ? `${appName}_${serviceName}` : appName}/${normalizeS3Path(prefix)}`;

export const loadDatabase = async <R extends Resource>(
	ctx: QueryCtx,
	databaseId: Id<"databases">,
	resource: R,
	action: Action<R>,
): Promise<{ database: Doc<"databases">; userId: string; access: Access }> => {
	const database = await ctx.db.get("databases", databaseId);
	if (!database) throw new ConvexError("Database not found");
	const access = await requireServicePermission(
		ctx,
		database,
		resource,
		action,
	);
	return { database, userId: access.userId, access };
};

export const loadDestination = async (
	ctx: QueryCtx,
	organizationId: string,
	destinationId: Id<"destinations">,
): Promise<Doc<"destinations">> => {
	const destination = await ctx.db.get("destinations", destinationId);
	if (!destination || destination.organizationId !== organizationId) {
		throw new ConvexError("Destination not found");
	}
	return destination;
};

export type ResolvedOwner = {
	organizationId: string;
	name: string;
	appName: string;
	serverId?: string;
	environmentId?: string;
	composeType?: "docker-compose" | "stack";
	engine?: Engine;
	// Jobs touching the owner's containers share its job group.
	group: string;
};

const resolveForeignService = async (
	ctx: QueryCtx,
	kind: "application" | "compose",
	id: string,
): Promise<ResolvedOwner | null> => {
	const service =
		kind === "application"
			? await (async () => {
					const appId = ctx.db.normalizeId("applications", id);
					return appId ? await ctx.db.get("applications", appId) : null;
				})()
			: await (async () => {
					const composeId = ctx.db.normalizeId("compose", id);
					return composeId ? await ctx.db.get("compose", composeId) : null;
				})();
	if (!service) return null;
	return {
		organizationId: service.organizationId,
		name: service.name,
		appName: service.appName,
		serverId: service.serverId,
		environmentId: service.environmentId,
		composeType: "composeType" in service ? service.composeType : undefined,
		group: `${kind}:${id}`,
	};
};

export const resolveOwner = async (
	ctx: QueryCtx,
	owner: BackupOwner | VolumeOwner,
): Promise<ResolvedOwner | null> => {
	if (owner.kind !== "database") {
		return await resolveForeignService(ctx, owner.kind, owner.id);
	}
	const databaseId = ctx.db.normalizeId("databases", owner.id);
	const database = databaseId
		? await ctx.db.get("databases", databaseId)
		: null;
	if (!database) return null;
	return {
		organizationId: database.organizationId,
		name: database.name,
		appName: database.appName,
		serverId: database.serverId,
		environmentId: database.environmentId,
		engine: database.engine,
		group: groupFor(database.engine, database._id),
	};
};

// Loads the owner and checks the caller's permission on that service.
export const requireOwner = async <R extends Resource>(
	ctx: QueryCtx,
	owner: BackupOwner | VolumeOwner,
	resource: R,
	action: Action<R>,
): Promise<{ resolved: ResolvedOwner; userId: string; access: Access }> => {
	const resolved = await resolveOwner(ctx, owner);
	if (!resolved) throw new ConvexError("Service not found");
	const access = await requireServicePermission(
		ctx,
		{ _id: owner.id, organizationId: resolved.organizationId },
		resource,
		action,
	);
	return { resolved, userId: access.userId, access };
};

export const projectNameOf = async (
	ctx: QueryCtx,
	environmentId: string | undefined,
): Promise<string> => {
	const id = environmentId
		? ctx.db.normalizeId("environments", environmentId)
		: null;
	const environment = id ? await ctx.db.get("environments", id) : null;
	const project = environment
		? await ctx.db.get("projects", environment.projectId)
		: null;
	return project?.name ?? "Unknown Project";
};

// Removes a pending scheduled function, ignoring ones that already ran.
export const cancelPending = async (
	ctx: MutationCtx,
	scheduledFunctionId: Id<"_scheduled_functions"> | undefined,
) => {
	if (!scheduledFunctionId) return;
	const pending = await ctx.db.system
		.get("_scheduled_functions", scheduledFunctionId)
		.catch(() => null);
	if (pending?.state.kind === "pending") {
		await ctx.scheduler.cancel(scheduledFunctionId);
	}
};

export const hasLiveRun = async (
	ctx: QueryCtx,
	scheduledFunctionId: Id<"_scheduled_functions"> | undefined,
) => {
	if (!scheduledFunctionId) return false;
	const scheduled = await ctx.db.system
		.get("_scheduled_functions", scheduledFunctionId)
		.catch(() => null);
	const state = scheduled?.state.kind;
	return state === "pending" || state === "inProgress";
};

// Lists the deploy-like history of a target with status from its job.
export const recentDeployments = async (
	ctx: QueryCtx,
	target: { kind: string; id: string },
	limit: number,
) => {
	const deployments = await ctx.db
		.query("deployments")
		.withIndex("by_target", (q) =>
			q.eq("target.kind", target.kind).eq("target.id", target.id),
		)
		.order("desc")
		.take(limit);
	return await Promise.all(
		deployments.map(async (deployment) => {
			const job = await ctx.db.get("jobs", deployment.jobId);
			return {
				deploymentId: deployment._id,
				jobId: deployment.jobId,
				title: deployment.title,
				description: deployment.description,
				imageRef: deployment.imageRef,
				createdAt: deployment._creationTime,
				status: job?.status ?? "failed",
				startedAt: job?.startedAt,
				finishedAt: job?.finishedAt,
				error: job?.error,
			};
		}),
	);
};

export const randomPassword = (length = 20) => {
	const alphabet =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
};
