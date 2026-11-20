import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { type Role, requireMember } from "./access";

// The permission model (resources × actions). Owners and admins hold every
// permission; members hold the default member grants plus the per-member
// grants of the "Add permissions" dialog (`memberGrants`).
export const statements = {
	organization: ["update", "delete"],
	member: ["read", "create", "update", "delete"],
	invitation: ["create", "cancel"],
	project: ["create", "delete"],
	service: ["create", "read", "delete"],
	environment: ["create", "read", "delete"],
	docker: ["read"],
	sshKeys: ["read", "create", "delete"],
	gitProviders: ["read", "create", "delete"],
	traefikFiles: ["read", "write"],
	api: ["read"],
	telemetryProvider: ["read", "create", "delete"],
	sandbox: ["read", "create", "delete"],
	volume: ["read", "create", "delete"],
	deployment: ["read", "create", "cancel"],
	envVars: ["read", "write"],
	projectEnvVars: ["read", "write"],
	environmentEnvVars: ["read", "write"],
	server: ["read", "create", "delete", "terminal"],
	registry: ["read", "create", "delete"],
	certificate: ["read", "create", "update", "delete"],
	backup: ["read", "create", "update", "delete", "restore"],
	volumeBackup: ["read", "create", "update", "delete", "restore"],
	schedule: ["read", "create", "update", "delete"],
	domain: ["read", "create", "delete"],
	destination: ["read", "create", "delete"],
	notification: ["read", "create", "update", "delete"],
	tag: ["read", "create", "update", "delete"],
	logs: ["read"],
	monitoring: ["read"],
	vaultProvider: ["read", "create", "update", "delete"],
	dnsProvider: ["read", "create", "update", "delete"],
	ai: ["read", "create", "update", "delete"],
} as const;

export type Resource = keyof typeof statements;
export type Action<R extends Resource> = (typeof statements)[R][number];
export type Permissions = {
	[R in Resource]: Record<Action<R>, boolean>;
};

// The default member role: members work inside the services they can
// reach (deploy, env, volumes, backups, schedules, domains, logs) but don't
// manage the organization's infrastructure.
const memberGrants: Partial<Record<Resource, readonly string[]>> = {
	service: ["read"],
	environment: ["read"],
	volume: ["read", "create", "delete"],
	deployment: ["read", "create", "cancel"],
	envVars: ["read", "write"],
	projectEnvVars: ["read", "write"],
	environmentEnvVars: ["read", "write"],
	backup: ["read", "create", "update", "delete", "restore"],
	volumeBackup: ["read", "create", "update", "delete", "restore"],
	schedule: ["read", "create", "update", "delete"],
	domain: ["read", "create", "delete"],
	logs: ["read"],
	monitoring: ["read"],
	tag: ["read"],
	// Members need provider/secret names for env editor autocomplete; values
	// are never exposed.
	vaultProvider: ["read"],
};

export const permissionsForRole = (role: Role): Permissions => {
	const privileged = role === "owner" || role === "admin";
	const result = {} as Record<string, Record<string, boolean>>;
	for (const [resource, actions] of Object.entries(statements)) {
		const granted = memberGrants[resource as Resource] ?? [];
		result[resource] = Object.fromEntries(
			actions.map((action) => [action, privileged || granted.includes(action)]),
		);
	}
	result.organization.delete = role === "owner";
	return result as Permissions;
};

export const GRANT_FLAGS = [
	"canCreateProjects",
	"canDeleteProjects",
	"canCreateServices",
	"canDeleteServices",
	"canCreateEnvironments",
	"canDeleteEnvironments",
	"canAccessToTraefikFiles",
	"canAccessToDocker",
	"canAccessToAPI",
	"canAccessToSSHKeys",
	"canAccessToGitProviders",
] as const;

export type GrantFlag = (typeof GRANT_FLAGS)[number];
export type MemberGrants = Pick<
	Doc<"memberGrants">,
	GrantFlag | "accessedProjects" | "accessedEnvironments" | "accessedServices"
>;

export const emptyGrants = (): MemberGrants => ({
	accessedProjects: [],
	accessedEnvironments: [],
	accessedServices: [],
	canCreateProjects: false,
	canDeleteProjects: false,
	canCreateServices: false,
	canDeleteServices: false,
	canCreateEnvironments: false,
	canDeleteEnvironments: false,
	canAccessToTraefikFiles: false,
	canAccessToDocker: false,
	canAccessToAPI: false,
	canAccessToSSHKeys: false,
	canAccessToGitProviders: false,
});

// Maps a member's grant flags to overrides of the default member role.
const grantOverrides = (
	grants: MemberGrants,
): Partial<Record<Resource, Record<string, boolean>>> => ({
	project: {
		create: grants.canCreateProjects,
		delete: grants.canDeleteProjects,
	},
	service: {
		create: grants.canCreateServices,
		delete: grants.canDeleteServices,
	},
	environment: {
		create: grants.canCreateEnvironments,
		delete: grants.canDeleteEnvironments,
	},
	traefikFiles: { read: grants.canAccessToTraefikFiles },
	docker: { read: grants.canAccessToDocker },
	api: { read: grants.canAccessToAPI },
	sshKeys: {
		read: grants.canAccessToSSHKeys,
		create: grants.canAccessToSSHKeys,
		delete: grants.canAccessToSSHKeys,
	},
	gitProviders: {
		read: grants.canAccessToGitProviders,
		create: grants.canAccessToGitProviders,
		delete: grants.canAccessToGitProviders,
	},
});

export const permissionsForMember = (
	role: Role,
	grants: MemberGrants | null,
): Permissions => {
	const result = permissionsForRole(role);
	if (role !== "member" || !grants) return result;
	const table = result as Record<string, Record<string, boolean>>;
	for (const [resource, actions] of Object.entries(grantOverrides(grants))) {
		for (const [action, granted] of Object.entries(actions ?? {})) {
			if (granted) table[resource][action] = true;
		}
	}
	return result;
};

// What a member may see: the projects, environments and services an admin
// gave them. `null` for owners and admins, who see everything.
export type Scope = {
	projects: ReadonlySet<string>;
	environments: ReadonlySet<string>;
	services: ReadonlySet<string>;
};

export type Access = {
	userId: string;
	role: Role;
	permissions: Permissions;
	scope: Scope | null;
};

export const loadGrants = async (
	ctx: QueryCtx,
	organizationId: string,
	userId: string,
): Promise<Doc<"memberGrants"> | null> =>
	await ctx.db
		.query("memberGrants")
		.withIndex("by_organizationId_and_userId", (q) =>
			q.eq("organizationId", organizationId).eq("userId", userId),
		)
		.unique();

export const resolvePermissions = async (
	ctx: QueryCtx,
	organizationId: string,
): Promise<Access> => {
	const { userId, role } = await requireMember(ctx, organizationId);
	if (role !== "member") {
		return { userId, role, permissions: permissionsForRole(role), scope: null };
	}
	const grants = await loadGrants(ctx, organizationId, userId);
	return {
		userId,
		role,
		permissions: permissionsForMember(role, grants),
		scope: {
			projects: new Set(grants?.accessedProjects ?? []),
			environments: new Set(grants?.accessedEnvironments ?? []),
			services: new Set(grants?.accessedServices ?? []),
		},
	};
};

export const hasPermission = <R extends Resource>(
	access: Pick<Access, "permissions">,
	resource: R,
	action: Action<R>,
): boolean =>
	(access.permissions[resource] as Record<string, boolean>)[action] === true;

const assertPermission = <R extends Resource>(
	access: Access,
	resource: R,
	action: Action<R>,
) => {
	if (!hasPermission(access, resource, action)) {
		throw new ConvexError(`Requires the ${resource}.${action} permission`);
	}
};

// Authorizes one action on one resource in an organization. Use this for
// every org-scoped function instead of a bare role check.
export const requirePermission = async <R extends Resource>(
	ctx: QueryCtx,
	organizationId: string,
	resource: R,
	action: Action<R>,
): Promise<Access> => {
	const access = await resolvePermissions(ctx, organizationId);
	assertPermission(access, resource, action);
	return access;
};

export const canAccessProject = (access: Access, projectId: string) =>
	!access.scope || access.scope.projects.has(projectId);

export const canAccessEnvironment = (access: Access, environmentId: string) =>
	!access.scope || access.scope.environments.has(environmentId);

export const canAccessService = (access: Access, serviceId: string) =>
	!access.scope || access.scope.services.has(serviceId);

type OrgRow = { _id: string; organizationId: string };

// The permission, plus (for
// members) the service among the ones they were given.
export const requireServicePermission = async <R extends Resource>(
	ctx: QueryCtx,
	service: OrgRow,
	resource: R,
	action: Action<R>,
): Promise<Access> => {
	const access = await requirePermission(
		ctx,
		service.organizationId,
		resource,
		action,
	);
	if (!canAccessService(access, service._id)) {
		throw new ConvexError("You don't have access to this service");
	}
	return access;
};

// Project-level checks without a resource (rename, open): the
// project must be among the member's.
export const requireProjectAccess = async (
	ctx: QueryCtx,
	project: OrgRow,
): Promise<Access> => {
	const access = await resolvePermissions(ctx, project.organizationId);
	if (!canAccessProject(access, project._id)) {
		throw new ConvexError("You don't have access to this project");
	}
	return access;
};

// Members may act on a project only when it was given to them.
export const requireProjectPermission = async <R extends Resource>(
	ctx: QueryCtx,
	project: OrgRow,
	resource: R,
	action: Action<R>,
): Promise<Access> => {
	const access = await requirePermission(
		ctx,
		project.organizationId,
		resource,
		action,
	);
	if (!canAccessProject(access, project._id)) {
		throw new ConvexError("You don't have access to this project");
	}
	return access;
};

export const requireEnvironmentPermission = async <R extends Resource>(
	ctx: QueryCtx,
	environment: OrgRow,
	resource: R,
	action: Action<R>,
): Promise<Access> => {
	const access = await requirePermission(
		ctx,
		environment.organizationId,
		resource,
		action,
	);
	if (!canAccessEnvironment(access, environment._id)) {
		throw new ConvexError("You don't have access to this environment");
	}
	return access;
};

// Creating a service: service.create and,
// for members, the environment's project among theirs.
export const requireServiceCreation = async (
	ctx: QueryCtx,
	environment: Pick<Doc<"environments">, "organizationId" | "projectId">,
): Promise<Access> => {
	const access = await requirePermission(
		ctx,
		environment.organizationId,
		"service",
		"create",
	);
	if (!canAccessProject(access, environment.projectId)) {
		throw new ConvexError("You don't have access to this project");
	}
	return access;
};

export type ServiceKind = "application" | "compose" | "database";

export type ServiceRow =
	| { kind: "application"; row: Doc<"applications"> }
	| { kind: "compose"; row: Doc<"compose"> }
	| { kind: "database"; row: Doc<"databases"> };

// Callers sometimes pass the id of any service type (a generic serviceId).
export const findService = async (
	ctx: QueryCtx,
	serviceId: string,
): Promise<ServiceRow | null> => {
	const applicationId = ctx.db.normalizeId("applications", serviceId);
	if (applicationId) {
		const row = await ctx.db.get("applications", applicationId);
		return row ? { kind: "application", row } : null;
	}
	const composeId = ctx.db.normalizeId("compose", serviceId);
	if (composeId) {
		const row = await ctx.db.get("compose", composeId);
		return row ? { kind: "compose", row } : null;
	}
	const databaseId = ctx.db.normalizeId("databases", serviceId);
	if (databaseId) {
		const row = await ctx.db.get("databases", databaseId);
		return row ? { kind: "database", row } : null;
	}
	return null;
};

const MAX_ACCESSED = 2000;

const appendUnique = (list: string[], id: string) =>
	list.includes(id) ? list : [...list, id].slice(-MAX_ACCESSED);

// Projects, environments and services: what a member
// creates becomes theirs. Owners and admins see everything already.
export const grantCreatedAccess = async (
	ctx: MutationCtx,
	access: Pick<Access, "userId" | "role">,
	organizationId: string,
	created: {
		projectId?: Id<"projects">;
		environmentId?: Id<"environments">;
		serviceId?: string;
	},
) => {
	if (access.role !== "member") return;
	const existing = await loadGrants(ctx, organizationId, access.userId);
	const grants = existing ?? emptyGrants();
	const next = {
		accessedProjects: created.projectId
			? appendUnique(grants.accessedProjects, created.projectId)
			: grants.accessedProjects,
		accessedEnvironments: created.environmentId
			? appendUnique(grants.accessedEnvironments, created.environmentId)
			: grants.accessedEnvironments,
		accessedServices: created.serviceId
			? appendUnique(grants.accessedServices, created.serviceId)
			: grants.accessedServices,
	};
	if (existing) {
		await ctx.db.patch("memberGrants", existing._id, next);
	} else {
		await ctx.db.insert("memberGrants", {
			...emptyGrants(),
			...next,
			organizationId,
			userId: access.userId,
		});
	}
};
