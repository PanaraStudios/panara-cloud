import { v } from "convex/values";
import { internalQuery, type QueryCtx } from "../_generated/server";
import { loadGrants } from "../lib/permissions";

const MAX_PROJECTS = 500;
const MAX_ENVIRONMENTS = 100;

type Visible = { projects: Set<string>; environments: Set<string> };

// What an API key's user may see, like canAccessProject/canAccessEnvironment
// in the app: null for owners and admins (everything), the grants for members.
const visibleTo = async (
	ctx: QueryCtx,
	organizationId: string,
	userId: string,
): Promise<Visible | null> => {
	const membership = await ctx.db
		.query("memberships")
		.withIndex("by_organizationId_and_userId", (q) =>
			q.eq("organizationId", organizationId).eq("userId", userId),
		)
		.unique();
	if (!membership) return { projects: new Set(), environments: new Set() };
	if (membership.role !== "member") return null;
	const grants = await loadGrants(ctx, organizationId, userId);
	return {
		projects: new Set(grants?.accessedProjects ?? []),
		environments: new Set(grants?.accessedEnvironments ?? []),
	};
};

// Read models for the REST API. Callers pass the organization from an
// authenticated API key (see lib/apiAuth.ts); never from request input.
export const listProjects = internalQuery({
	args: { organizationId: v.string(), userId: v.string(), limit: v.number() },
	handler: async (ctx, { organizationId, userId, limit }) => {
		const visible = await visibleTo(ctx, organizationId, userId);
		const projects = await ctx.db
			.query("projects")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_PROJECTS);
		return projects
			.filter((project) => !visible || visible.projects.has(project._id))
			.slice(0, Math.min(Math.max(limit, 1), MAX_PROJECTS))
			.map((project) => ({
				id: project._id,
				name: project.name,
				description: project.description ?? null,
				createdAt: new Date(project._creationTime).toISOString(),
			}));
	},
});

export const getProject = internalQuery({
	args: {
		organizationId: v.string(),
		userId: v.string(),
		projectId: v.string(),
	},
	handler: async (ctx, { organizationId, userId, projectId }) => {
		const id = ctx.db.normalizeId("projects", projectId);
		const project = id ? await ctx.db.get("projects", id) : null;
		if (!project || project.organizationId !== organizationId) return null;
		const visible = await visibleTo(ctx, organizationId, userId);
		if (visible && !visible.projects.has(project._id)) return null;
		const [environments, projectTags] = await Promise.all([
			ctx.db
				.query("environments")
				.withIndex("by_projectId", (q) => q.eq("projectId", project._id))
				.take(MAX_ENVIRONMENTS),
			ctx.db
				.query("projectTags")
				.withIndex("by_projectId_and_tagId", (q) =>
					q.eq("projectId", project._id),
				)
				.take(MAX_ENVIRONMENTS),
		]);
		const tags = await Promise.all(
			projectTags.map((link) => ctx.db.get("tags", link.tagId)),
		);
		return {
			id: project._id,
			name: project.name,
			description: project.description ?? null,
			createdAt: new Date(project._creationTime).toISOString(),
			environments: environments
				.filter(
					(environment) =>
						!visible || visible.environments.has(environment._id),
				)
				.map((environment) => ({
					id: environment._id,
					name: environment.name,
					description: environment.description ?? null,
					isDefault: environment.isDefault,
				})),
			tags: tags.flatMap((tag) =>
				tag ? [{ id: tag._id, name: tag.name, color: tag.color ?? null }] : [],
			),
		};
	},
});
