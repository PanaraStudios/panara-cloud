import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	action,
	internalMutation,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import { removeEnvironmentServices } from "./lib/cascade";
import { encryptSecret } from "./lib/crypto";
import { ENVIRONMENT_ENV_KIND } from "./lib/env";
import {
	type Access,
	canAccessEnvironment,
	canAccessProject,
	canAccessService,
	grantCreatedAccess,
	requireEnvironmentPermission,
	requirePermission,
	requireProjectPermission,
	resolvePermissions,
} from "./lib/permissions";
import { deleteSecret, putSecret, readSecret } from "./lib/secrets";

const MAX_ENVIRONMENTS = 100;
const MAX_SERVICES_PER_KIND = 500;

export type ServiceType =
	| "application"
	| "compose"
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis"
	| "libsql";

export type ServiceSummary = {
	id: string;
	type: ServiceType;
	name: string;
	appName: string;
	description: string | null;
	status: "idle" | "running" | "done" | "error";
	serverId: Id<"servers"> | null;
	icon: string | null;
	createdAt: number;
};

// Every service in an environment, as one flat "Services" list.
export const listEnvironmentServices = async (
	ctx: QueryCtx,
	environmentId: Id<"environments">,
): Promise<ServiceSummary[]> => {
	const [applications, compose, databases] = await Promise.all([
		ctx.db
			.query("applications")
			.withIndex("by_environmentId", (q) =>
				q.eq("environmentId", environmentId),
			)
			.take(MAX_SERVICES_PER_KIND),
		ctx.db
			.query("compose")
			.withIndex("by_environmentId", (q) =>
				q.eq("environmentId", environmentId),
			)
			.take(MAX_SERVICES_PER_KIND),
		ctx.db
			.query("databases")
			.withIndex("by_environmentId", (q) =>
				q.eq("environmentId", environmentId),
			)
			.take(MAX_SERVICES_PER_KIND),
	]);
	const common = (
		row: Doc<"applications"> | Doc<"compose"> | Doc<"databases">,
	) => ({
		id: row._id as string,
		name: row.name,
		appName: row.appName,
		description: row.description ?? null,
		status: row.status,
		serverId: row.serverId ?? null,
		createdAt: row._creationTime,
	});
	return [
		...applications.map((row) => ({
			...common(row),
			type: "application" as const,
			icon: null,
		})),
		...compose.map((row) => ({
			...common(row),
			type: "compose" as const,
			icon: row.icon ?? null,
		})),
		...databases.map((row) => ({
			...common(row),
			type: row.engine,
			icon: null,
		})),
	];
};

// The caller's access when they may open the environment, else null.
const readAccess = async (
	ctx: QueryCtx,
	environment: Doc<"environments">,
): Promise<Access | null> => {
	try {
		const access = await resolvePermissions(ctx, environment.organizationId);
		return canAccessEnvironment(access, environment._id) ? access : null;
	} catch {
		return null;
	}
};

const assertNameAvailable = async (
	ctx: MutationCtx,
	projectId: Id<"projects">,
	name: string,
	exceptId?: Id<"environments">,
) => {
	const existing = await ctx.db
		.query("environments")
		.withIndex("by_projectId_and_name", (q) =>
			q.eq("projectId", projectId).eq("name", name),
		)
		.first();
	if (existing && existing._id !== exceptId) {
		throw new ConvexError(`Environment "${name}" already exists`);
	}
};

export const list = query({
	args: { projectId: v.id("projects") },
	handler: async (ctx, { projectId }) => {
		const project = await ctx.db.get("projects", projectId);
		if (!project) return [];
		const access = await resolvePermissions(ctx, project.organizationId);
		if (!canAccessProject(access, projectId)) return [];
		const environments = await ctx.db
			.query("environments")
			.withIndex("by_projectId", (q) => q.eq("projectId", projectId))
			.take(MAX_ENVIRONMENTS);
		return environments.filter((environment) =>
			canAccessEnvironment(access, environment._id),
		);
	},
});

// The environment page header: the environment, its project and whether the
// caller may open it (null for unknown ids or other organizations, so a stale
// link renders "not found" instead of throwing).
export const get = query({
	args: { environmentId: v.id("environments") },
	handler: async (ctx, { environmentId }) => {
		const environment = await ctx.db.get("environments", environmentId);
		if (!environment) return null;
		if (!(await readAccess(ctx, environment))) return null;
		const project = await ctx.db.get("projects", environment.projectId);
		if (!project) return null;
		return {
			...environment,
			project: {
				_id: project._id,
				name: project.name,
				description: project.description ?? null,
			},
		};
	},
});

// Services of one environment with what the service cards show: server name
// and the time of the latest deployment.
export const services = query({
	args: { environmentId: v.id("environments") },
	handler: async (ctx, { environmentId }) => {
		const environment = await ctx.db.get("environments", environmentId);
		if (!environment) return [];
		const access = await readAccess(ctx, environment);
		if (!access) return [];
		const services = (await listEnvironmentServices(ctx, environmentId)).filter(
			(service) => canAccessService(access, service.id),
		);
		const serverNames = new Map<string, string | null>();
		for (const service of services) {
			if (service.serverId && !serverNames.has(service.serverId)) {
				const server = await ctx.db.get("servers", service.serverId);
				serverNames.set(service.serverId, server?.name ?? null);
			}
		}
		return await Promise.all(
			services.map(async (service) => {
				const kind =
					service.type === "application" || service.type === "compose"
						? service.type
						: "database";
				const latest = await ctx.db
					.query("deployments")
					.withIndex("by_target", (q) =>
						q.eq("target.kind", kind).eq("target.id", service.id),
					)
					.order("desc")
					.first();
				const domain =
					kind === "database"
						? null
						: await ctx.db
								.query("domains")
								.withIndex("by_owner", (q) =>
									q.eq("owner.kind", kind).eq("owner.id", service.id),
								)
								.first();
				return {
					...service,
					domain: domain
						? {
								host: domain.host,
								path: domain.path,
								https: domain.https,
							}
						: null,
					serverName: service.serverId
						? (serverNames.get(service.serverId) ?? null)
						: null,
					lastDeployDate: latest?._creationTime ?? null,
				};
			}),
		);
	},
});

export const create = mutation({
	args: {
		projectId: v.id("projects"),
		name: v.string(),
		description: v.optional(v.string()),
	},
	handler: async (ctx, { projectId, name, description }) => {
		const project = await ctx.db.get("projects", projectId);
		if (!project) throw new ConvexError("Project not found");
		const access = await requireProjectPermission(
			ctx,
			project,
			"environment",
			"create",
		);
		const trimmed = name.trim();
		if (!trimmed) throw new ConvexError("Environment name is required");
		await assertNameAvailable(ctx, projectId, trimmed);
		const environmentId = await ctx.db.insert("environments", {
			organizationId: project.organizationId,
			projectId,
			name: trimmed,
			description,
			isDefault: false,
		});
		await grantCreatedAccess(ctx, access, project.organizationId, {
			environmentId,
		});
		return environmentId;
	},
});

export const update = mutation({
	args: {
		environmentId: v.id("environments"),
		name: v.optional(v.string()),
		description: v.optional(v.string()),
	},
	handler: async (ctx, { environmentId, name, description }) => {
		const environment = await ctx.db.get("environments", environmentId);
		if (!environment) throw new ConvexError("Environment not found");
		await requireEnvironmentPermission(ctx, environment, "environment", "read");
		const trimmed = name?.trim();
		if (name !== undefined) {
			if (!trimmed) throw new ConvexError("Environment name is required");
			await assertNameAvailable(
				ctx,
				environment.projectId,
				trimmed,
				environmentId,
			);
		}
		await ctx.db.patch("environments", environmentId, {
			...(trimmed ? { name: trimmed } : {}),
			...(description !== undefined ? { description } : {}),
		});
	},
});

export const remove = mutation({
	args: { environmentId: v.id("environments") },
	handler: async (ctx, { environmentId }) => {
		const environment = await ctx.db.get("environments", environmentId);
		if (!environment) return;
		await requireEnvironmentPermission(ctx, environment, "environment", "read");
		await requireProjectPermission(
			ctx,
			{
				_id: environment.projectId,
				organizationId: environment.organizationId,
			},
			"environment",
			"delete",
		);
		if (environment.isDefault) {
			throw new ConvexError("The default environment cannot be deleted");
		}
		await ctx.db.delete("environments", environmentId);
		await deleteSecret(ctx, ENVIRONMENT_ENV_KIND, environmentId);
		await removeEnvironmentServices(ctx, environmentId);
	},
});

// Duplicates an environment: a new environment with the same
// description and shared variables; services are not copied.
export const duplicate = mutation({
	args: {
		environmentId: v.id("environments"),
		name: v.string(),
		description: v.optional(v.string()),
	},
	handler: async (ctx, { environmentId, name, description }) => {
		const source = await ctx.db.get("environments", environmentId);
		if (!source) throw new ConvexError("Environment not found");
		await requireEnvironmentPermission(ctx, source, "environment", "read");
		const access = await requireProjectPermission(
			ctx,
			{ _id: source.projectId, organizationId: source.organizationId },
			"environment",
			"create",
		);
		const trimmed = name.trim();
		if (!trimmed) throw new ConvexError("Environment name is required");
		await assertNameAvailable(ctx, source.projectId, trimmed);
		const duplicateId = await ctx.db.insert("environments", {
			organizationId: source.organizationId,
			projectId: source.projectId,
			name: trimmed,
			description: description?.trim() || source.description,
			isDefault: false,
		});
		const env = await ctx.db
			.query("secrets")
			.withIndex("by_kind_and_ownerId", (q) =>
				q.eq("kind", ENVIRONMENT_ENV_KIND).eq("ownerId", environmentId),
			)
			.unique();
		if (env) {
			await putSecret(ctx, {
				organizationId: source.organizationId,
				kind: ENVIRONMENT_ENV_KIND,
				ownerId: duplicateId,
				iv: env.iv,
				ciphertext: env.ciphertext,
			});
		}
		await grantCreatedAccess(ctx, access, source.organizationId, {
			environmentId: duplicateId,
		});
		return duplicateId;
	},
});

export const getEnv = query({
	args: { environmentId: v.id("environments") },
	handler: async (ctx, { environmentId }) => {
		const environment = await ctx.db.get("environments", environmentId);
		if (!environment) return null;
		// null outside the member's environments, as projects.getEnv.
		const access = await requirePermission(
			ctx,
			environment.organizationId,
			"environmentEnvVars",
			"read",
		);
		if (!canAccessEnvironment(access, environmentId)) return null;
		return (await readSecret(ctx, ENVIRONMENT_ENV_KIND, environmentId)) ?? "";
	},
});

export const setEnv = action({
	args: { environmentId: v.id("environments"), env: v.string() },
	handler: async (ctx, { environmentId, env }) => {
		await ctx.runMutation(internal.environments.storeEnv, {
			environmentId,
			...(await encryptSecret(env)),
		});
	},
});

export const storeEnv = internalMutation({
	args: {
		environmentId: v.id("environments"),
		iv: v.string(),
		ciphertext: v.string(),
	},
	handler: async (ctx, { environmentId, iv, ciphertext }) => {
		const environment = await ctx.db.get("environments", environmentId);
		if (!environment) throw new ConvexError("Environment not found");
		await requireEnvironmentPermission(
			ctx,
			environment,
			"environmentEnvVars",
			"write",
		);
		await putSecret(ctx, {
			organizationId: environment.organizationId,
			kind: ENVIRONMENT_ENV_KIND,
			ownerId: environmentId,
			iv,
			ciphertext,
		});
	},
});
