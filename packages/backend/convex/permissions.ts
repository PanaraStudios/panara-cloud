import { ConvexError, v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import { listEnvironmentServices } from "./environments";
import { refuseApiKeyForPeople, requireCaller } from "./lib/access";
import {
	type Action,
	emptyGrants,
	findService,
	GRANT_FLAGS,
	loadGrants,
	type Resource,
	requirePermission,
	requireServicePermission,
	statements,
} from "./lib/permissions";
import { revokeLiveSessions } from "./live/revoke";
import { deleteApiKeysWithoutAccess } from "./platform/lib/apiKeyRows";

const MAX_PROJECTS = 500;
const MAX_ENVIRONMENTS = 100;
const MAX_ACCESSED = 2000;

const grantFlags = Object.fromEntries(
	GRANT_FLAGS.map((flag) => [flag, v.boolean()]),
) as Record<(typeof GRANT_FLAGS)[number], ReturnType<typeof v.boolean>>;

const loadTargetMember = async (
	ctx: Parameters<typeof requirePermission>[0],
	organizationId: string,
	userId: string,
) =>
	await ctx.db
		.query("memberships")
		.withIndex("by_organizationId_and_userId", (q) =>
			q.eq("organizationId", organizationId).eq("userId", userId),
		)
		.unique();

// For the permissions dialog: a member's current grants.
export const forMember = query({
	args: { organizationId: v.string(), userId: v.string() },
	handler: async (ctx, { organizationId, userId }) => {
		await requirePermission(ctx, organizationId, "member", "update");
		const target = await loadTargetMember(ctx, organizationId, userId);
		if (!target) throw new ConvexError("Member not found");
		const grants = await loadGrants(ctx, organizationId, userId);
		const { _id, _creationTime, ...rest } = grants ?? {
			_id: null,
			_creationTime: null,
			...emptyGrants(),
			organizationId,
			userId,
		};
		return { ...rest, role: target.role };
	},
});

// Assigns a member's permissions. Only ids of this organization are kept,
// so a stale or foreign id can't widen a member's scope.
export const assign = mutation({
	args: {
		organizationId: v.string(),
		userId: v.string(),
		accessedProjects: v.array(v.string()),
		accessedEnvironments: v.array(v.string()),
		accessedServices: v.array(v.string()),
		...grantFlags,
	},
	handler: async (ctx, args) => {
		await refuseApiKeyForPeople(ctx);
		const { userId: callerId } = await requirePermission(
			ctx,
			args.organizationId,
			"member",
			"update",
		);
		if (args.userId === callerId) {
			throw new ConvexError("You can't change your own permissions");
		}
		const target = await loadTargetMember(
			ctx,
			args.organizationId,
			args.userId,
		);
		if (!target) throw new ConvexError("Member not found");
		if (target.role !== "member") {
			throw new ConvexError("Owners and admins already hold every permission");
		}
		if (
			args.accessedProjects.length > MAX_ACCESSED ||
			args.accessedEnvironments.length > MAX_ACCESSED ||
			args.accessedServices.length > MAX_ACCESSED
		) {
			throw new ConvexError(`At most ${MAX_ACCESSED} entries per list`);
		}
		const inOrganization = (row: { organizationId: string } | null) =>
			row?.organizationId === args.organizationId;
		const accessedProjects: string[] = [];
		for (const id of new Set(args.accessedProjects)) {
			const projectId = ctx.db.normalizeId("projects", id);
			if (
				projectId &&
				inOrganization(await ctx.db.get("projects", projectId))
			) {
				accessedProjects.push(projectId);
			}
		}
		const accessedEnvironments: string[] = [];
		for (const id of new Set(args.accessedEnvironments)) {
			const environmentId = ctx.db.normalizeId("environments", id);
			if (
				environmentId &&
				inOrganization(await ctx.db.get("environments", environmentId))
			) {
				accessedEnvironments.push(environmentId);
			}
		}
		const accessedServices: string[] = [];
		for (const id of new Set(args.accessedServices)) {
			const service = await findService(ctx, id);
			if (service && inOrganization(service.row)) accessedServices.push(id);
		}
		const grants = {
			...Object.fromEntries(GRANT_FLAGS.map((flag) => [flag, args[flag]])),
			accessedProjects,
			accessedEnvironments,
			accessedServices,
		} as ReturnType<typeof emptyGrants>;
		const existing = await loadGrants(ctx, args.organizationId, args.userId);
		if (existing) {
			await ctx.db.patch("memberGrants", existing._id, grants);
		} else {
			await ctx.db.insert("memberGrants", {
				...grants,
				organizationId: args.organizationId,
				userId: args.userId,
			});
		}
		await deleteApiKeysWithoutAccess(
			ctx,
			args.userId,
			args.organizationId,
			target.role,
		);
		// Streams opened under the previous grants end; the member reopens
		// what they can still reach.
		await revokeLiveSessions(ctx, {
			userId: args.userId,
			organizationId: args.organizationId,
		});
	},
});

// Every project, environment and service
// of the organization, for the permissions dialog.
export const projects = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requirePermission(ctx, organizationId, "member", "update");
		const projects = await ctx.db
			.query("projects")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_PROJECTS);
		return await Promise.all(
			projects.map(async (project) => {
				const environments = await ctx.db
					.query("environments")
					.withIndex("by_projectId", (q) => q.eq("projectId", project._id))
					.take(MAX_ENVIRONMENTS);
				return {
					projectId: project._id,
					name: project.name,
					environments: await Promise.all(
						environments.map(async (environment) => ({
							environmentId: environment._id,
							name: environment.name,
							services: (
								await listEnvironmentServices(ctx, environment._id)
							).map((service) => ({
								id: service.id,
								name: service.name,
								appName: service.appName,
								type: service.type,
								createdAt: service.createdAt,
							})),
						})),
					),
				};
			}),
		);
	},
});

const isAction = (resource: string, action: string) =>
	resource in statements &&
	(statements[resource as Resource] as readonly string[]).includes(action);

// For actions, which can't read memberships themselves: the caller must hold
// `resource.action` in the organization and, with `serviceId`, have that
// service among theirs.
export const check = internalQuery({
	args: {
		organizationId: v.string(),
		resource: v.string(),
		action: v.string(),
		serviceId: v.optional(v.string()),
	},
	handler: async (ctx, { organizationId, resource, action, serviceId }) => {
		await requireCaller(ctx);
		if (!isAction(resource, action)) {
			throw new ConvexError(`Unknown permission ${resource}.${action}`);
		}
		const r = resource as Resource;
		const a = action as Action<Resource>;
		if (serviceId === undefined) {
			const { userId, role } = await requirePermission(
				ctx,
				organizationId,
				r,
				a,
			);
			return { userId, role };
		}
		const service = await findService(ctx, serviceId);
		if (!service || service.row.organizationId !== organizationId) {
			throw new ConvexError("Service not found");
		}
		const { userId, role } = await requireServicePermission(
			ctx,
			service.row,
			r,
			a,
		);
		return { userId, role };
	},
});
