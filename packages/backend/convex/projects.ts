import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
	action,
	internalMutation,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import { listEnvironmentServices } from "./environments";
import { removeEnvironmentServices } from "./lib/cascade";
import { encryptSecret } from "./lib/crypto";
import { ENVIRONMENT_ENV_KIND, PROJECT_ENV_KIND } from "./lib/env";
import {
	canAccessEnvironment,
	canAccessProject,
	canAccessService,
	grantCreatedAccess,
	requirePermission,
	requireProjectAccess,
	requireProjectPermission,
	resolvePermissions,
} from "./lib/permissions";
import { deleteSecret, putSecret, readSecret } from "./lib/secrets";

const MAX_PROJECTS = 500;
// Bounds the reads behind a project's "last deploy" in the projects list.
const MAX_LAST_DEPLOY_SERVICES = 50;

export const list = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		const access = await resolvePermissions(ctx, organizationId);
		const projects = await ctx.db
			.query("projects")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_PROJECTS);
		return projects.filter((project) => canAccessProject(access, project._id));
	},
});

const MAX_ENVIRONMENTS = 50;
const MAX_TAGS_PER_PROJECT = 50;

// Every project with its environments, their services
// and the project's tags. Drives the projects page, the search command and
// the breadcrumb project switcher.
// Newest deployment start across the given services (null: never deployed).
const latestDeployAt = async (
	ctx: QueryCtx,
	services: readonly { id: string; type: string }[],
): Promise<number | null> => {
	let latest: number | null = null;
	for (const service of services.slice(0, MAX_LAST_DEPLOY_SERVICES)) {
		const kind =
			service.type === "application" || service.type === "compose"
				? service.type
				: "database";
		const deployment = await ctx.db
			.query("deployments")
			.withIndex("by_target", (q) =>
				q.eq("target.kind", kind).eq("target.id", service.id),
			)
			.order("desc")
			.first();
		if (deployment && (latest === null || deployment._creationTime > latest)) {
			latest = deployment._creationTime;
		}
	}
	return latest;
};

export const all = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		const access = await resolvePermissions(ctx, organizationId);
		const projects = (
			await ctx.db
				.query("projects")
				.withIndex("by_organizationId", (q) =>
					q.eq("organizationId", organizationId),
				)
				.take(MAX_PROJECTS)
		).filter((project) => canAccessProject(access, project._id));
		return await Promise.all(
			projects.map(async (project) => {
				const environments = (
					await ctx.db
						.query("environments")
						.withIndex("by_projectId", (q) => q.eq("projectId", project._id))
						.take(MAX_ENVIRONMENTS)
				).filter((environment) =>
					canAccessEnvironment(access, environment._id),
				);
				const tagLinks = await ctx.db
					.query("projectTags")
					.withIndex("by_projectId_and_tagId", (q) =>
						q.eq("projectId", project._id),
					)
					.take(MAX_TAGS_PER_PROJECT);
				const tags = await Promise.all(
					tagLinks.map((link) => ctx.db.get("tags", link.tagId)),
				);
				const projectEnvironments = await Promise.all(
					environments.map(async (environment) => ({
						environmentId: environment._id,
						name: environment.name,
						description: environment.description ?? null,
						isDefault: environment.isDefault,
						services: (
							await listEnvironmentServices(ctx, environment._id)
						).filter((service) => canAccessService(access, service.id)),
					})),
				);
				return {
					projectId: project._id,
					name: project.name,
					description: project.description ?? null,
					createdAt: project._creationTime,
					environments: projectEnvironments,
					lastDeployAt: await latestDeployAt(
						ctx,
						projectEnvironments.flatMap((environment) => environment.services),
					),
					tags: tags.flatMap((tag) =>
						tag
							? [{ tagId: tag._id, name: tag.name, color: tag.color ?? null }]
							: [],
					),
				};
			}),
		);
	},
});

export const get = query({
	args: { projectId: v.id("projects") },
	handler: async (ctx, { projectId }) => {
		const project = await ctx.db.get("projects", projectId);
		if (!project) return null;
		const access = await resolvePermissions(ctx, project.organizationId);
		return canAccessProject(access, project._id) ? project : null;
	},
});

export const create = mutation({
	args: {
		organizationId: v.string(),
		name: v.string(),
		description: v.optional(v.string()),
	},
	handler: async (ctx, { organizationId, name, description }) => {
		const access = await requirePermission(
			ctx,
			organizationId,
			"project",
			"create",
		);
		const trimmed = name.trim();
		if (!trimmed) throw new ConvexError("Project name is required");
		const projectId = await ctx.db.insert("projects", {
			organizationId,
			name: trimmed,
			description,
		});
		const environmentId = await ctx.db.insert("environments", {
			organizationId,
			projectId,
			name: "production",
			description: "Production environment",
			isDefault: true,
		});
		await grantCreatedAccess(ctx, access, organizationId, {
			projectId,
			environmentId,
		});
		return { projectId, environmentId };
	},
});

export const update = mutation({
	args: {
		projectId: v.id("projects"),
		name: v.optional(v.string()),
		description: v.optional(v.string()),
	},
	handler: async (ctx, { projectId, name, description }) => {
		const project = await ctx.db.get("projects", projectId);
		if (!project) throw new ConvexError("Project not found");
		await requireProjectAccess(ctx, project);
		const trimmed = name?.trim();
		if (name !== undefined && !trimmed) {
			throw new ConvexError("Project name is required");
		}
		await ctx.db.patch("projects", projectId, {
			...(trimmed ? { name: trimmed } : {}),
			...(description !== undefined ? { description } : {}),
		});
	},
});

export const remove = mutation({
	args: { projectId: v.id("projects") },
	handler: async (ctx, { projectId }) => {
		const project = await ctx.db.get("projects", projectId);
		if (!project) return;
		await requireProjectPermission(ctx, project, "project", "delete");
		await ctx.db.delete("projects", projectId);
		await ctx.scheduler.runAfter(0, internal.projects.deleteEnvironments, {
			projectId,
		});
		await ctx.scheduler.runAfter(0, internal.platform.tags.removeProjectLinks, {
			projectId,
		});
		await deleteSecret(ctx, PROJECT_ENV_KIND, projectId);
	},
});

export const getEnv = query({
	args: { projectId: v.id("projects") },
	handler: async (ctx, { projectId }) => {
		const project = await ctx.db.get("projects", projectId);
		if (!project) return null;
		// null outside the member's projects: service env editors ask for the
		// shared variables of a project the member may not have been given.
		const access = await requirePermission(
			ctx,
			project.organizationId,
			"projectEnvVars",
			"read",
		);
		if (!canAccessProject(access, projectId)) return null;
		return (await readSecret(ctx, PROJECT_ENV_KIND, projectId)) ?? "";
	},
});

export const setEnv = action({
	args: { projectId: v.id("projects"), env: v.string() },
	handler: async (ctx, { projectId, env }) => {
		await ctx.runMutation(internal.projects.storeEnv, {
			projectId,
			...(await encryptSecret(env)),
		});
	},
});

export const storeEnv = internalMutation({
	args: { projectId: v.id("projects"), iv: v.string(), ciphertext: v.string() },
	handler: async (ctx, { projectId, iv, ciphertext }) => {
		const project = await ctx.db.get("projects", projectId);
		if (!project) throw new ConvexError("Project not found");
		await requireProjectPermission(ctx, project, "projectEnvVars", "write");
		await putSecret(ctx, {
			organizationId: project.organizationId,
			kind: PROJECT_ENV_KIND,
			ownerId: projectId,
			iv,
			ciphertext,
		});
	},
});

const DELETE_BATCH = 100;

export const deleteEnvironments = internalMutation({
	args: { projectId: v.id("projects") },
	handler: async (ctx, { projectId }) => {
		const batch = await ctx.db
			.query("environments")
			.withIndex("by_projectId", (q) => q.eq("projectId", projectId))
			.take(DELETE_BATCH);
		for (const environment of batch) {
			await ctx.db.delete("environments", environment._id);
			await deleteSecret(ctx, ENVIRONMENT_ENV_KIND, environment._id);
			await removeEnvironmentServices(ctx, environment._id);
		}
		if (batch.length === DELETE_BATCH) {
			await ctx.scheduler.runAfter(0, internal.projects.deleteEnvironments, {
				projectId,
			});
		}
	},
});
