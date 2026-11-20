import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
	internalMutation,
	internalQuery,
	type MutationCtx,
	mutation,
	query,
} from "../_generated/server";
import { requireMember } from "../lib/access";
import { ENVIRONMENT_ENV_KIND, PROJECT_ENV_KIND } from "../lib/env";
import {
	canAccessProject,
	canAccessService,
	grantCreatedAccess,
	requirePermission,
} from "../lib/permissions";
import { putSecret, readSecret } from "../lib/secrets";
import { transferSections } from "./lib/transferRegistry";
import { assertImportServer } from "./lib/transferRows";

const MAX_ENVIRONMENTS = 100;
const MAX_TAGS = 50;
const MAX_EXPORTS = 100;

export const BUNDLE_FORMAT = "panara-cloud-project-export" as const;
export const BUNDLE_FORMAT_VERSION = 1;

const sealedValue = v.object({ iv: v.string(), ciphertext: v.string() });

// Project and environment variables travel as plaintext `env` in encrypted
// bundles; the import action seals them into `sealedEnv` before the import
// mutation runs.
export const bundlePayload = v.object({
	project: v.object({
		name: v.string(),
		description: v.optional(v.string()),
		sealedEnv: v.optional(sealedValue),
	}),
	environments: v.array(
		v.object({
			id: v.string(),
			name: v.string(),
			description: v.optional(v.string()),
			isDefault: v.boolean(),
			sealedEnv: v.optional(sealedValue),
		}),
	),
	tags: v.array(v.object({ name: v.string(), color: v.optional(v.string()) })),
	sections: v.record(v.string(), v.array(v.any())),
	warnings: v.array(v.string()),
});

const MAX_EXPORT_SERVICES = 1000;

const SERVICE_TABLES = ["applications", "compose", "databases"] as const;

// The project, the chosen environments (all by default) and, for a subset
// export, the app names of the chosen services.
export const loadForExport = internalQuery({
	args: {
		projectId: v.id("projects"),
		environmentIds: v.optional(v.array(v.id("environments"))),
		serviceIds: v.optional(v.array(v.string())),
		includeEnv: v.optional(v.boolean()),
	},
	handler: async (
		ctx,
		{ projectId, environmentIds, serviceIds, includeEnv },
	) => {
		const project = await ctx.db.get("projects", projectId);
		if (!project) throw new ConvexError("Project not found");
		await requireMember(ctx, project.organizationId, "admin");
		if ((serviceIds?.length ?? 0) > MAX_EXPORT_SERVICES) {
			throw new ConvexError("Too many services selected");
		}
		const [allEnvironments, links] = await Promise.all([
			ctx.db
				.query("environments")
				.withIndex("by_projectId", (q) => q.eq("projectId", projectId))
				.take(MAX_ENVIRONMENTS),
			ctx.db
				.query("projectTags")
				.withIndex("by_projectId_and_tagId", (q) =>
					q.eq("projectId", projectId),
				)
				.take(MAX_TAGS),
		]);
		const tags = await Promise.all(
			links.map((link) => ctx.db.get("tags", link.tagId)),
		);
		const chosen = environmentIds && new Set<string>(environmentIds);
		const environments = allEnvironments.filter(
			(environment) => !chosen || chosen.has(environment._id),
		);
		if (environments.length === 0) {
			throw new ConvexError("Select at least one environment");
		}
		let appNames: string[] | null = null;
		if (serviceIds) {
			appNames = [];
			for (const serviceId of serviceIds) {
				let row = null;
				for (const table of SERVICE_TABLES) {
					const id = ctx.db.normalizeId(table, serviceId);
					if (id) {
						row = await ctx.db.get(id);
						break;
					}
				}
				if (
					!row ||
					row.projectId !== projectId ||
					!environments.some((e) => e._id === row.environmentId)
				) {
					throw new ConvexError("Service not found in this project");
				}
				appNames.push(row.appName);
			}
		}
		const env = async (kind: string, ownerId: string) =>
			includeEnv
				? ((await readSecret(ctx, kind, ownerId)) ?? undefined)
				: undefined;
		return {
			organizationId: project.organizationId,
			project: {
				name: project.name,
				description: project.description,
				env: await env(PROJECT_ENV_KIND, projectId),
			},
			environments: await Promise.all(
				environments.map(async (environment) => ({
					id: environment._id,
					name: environment.name,
					description: environment.description,
					isDefault: environment.isDefault,
					env: await env(ENVIRONMENT_ENV_KIND, environment._id),
				})),
			),
			tags: tags.flatMap((tag) =>
				tag ? [{ name: tag.name, color: tag.color }] : [],
			),
			appNames,
		};
	},
});

export const recordExport = internalMutation({
	args: {
		organizationId: v.string(),
		projectId: v.id("projects"),
		storageId: v.id("_storage"),
		fileName: v.string(),
		encrypted: v.boolean(),
	},
	handler: async (ctx, args) => {
		const { userId } = await requireMember(ctx, args.organizationId, "admin");
		return await ctx.db.insert("projectExports", {
			...args,
			requestedBy: userId,
		});
	},
});

export const listExports = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requireMember(ctx, organizationId, "admin");
		const exports = await ctx.db
			.query("projectExports")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.order("desc")
			.take(MAX_EXPORTS);
		return await Promise.all(
			exports.map(async (row) => ({
				...row,
				url: await ctx.storage.getUrl(row.storageId),
			})),
		);
	},
});

export const removeExport = mutation({
	args: { exportId: v.id("projectExports") },
	handler: async (ctx, { exportId }) => {
		const row = await ctx.db.get("projectExports", exportId);
		if (!row) return;
		await requireMember(ctx, row.organizationId, "admin");
		await ctx.storage.delete(row.storageId);
		await ctx.db.delete("projectExports", exportId);
	},
});

export const generateImportUploadUrl = mutation({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requireMember(ctx, organizationId, "admin");
		return await ctx.storage.generateUploadUrl();
	},
});

export const authorizeImport = internalQuery({
	args: {
		organizationId: v.string(),
		serverId: v.optional(v.id("servers")),
	},
	handler: async (ctx, { organizationId, serverId }) => {
		await requireMember(ctx, organizationId, "admin");
		if (serverId) await assertImportServer(ctx, organizationId, serverId);
	},
});

// Recreates the project, its environments and tags, then lets each
// registered section import its rows, all in one transaction.
export const applyImport = internalMutation({
	args: {
		organizationId: v.string(),
		payload: bundlePayload,
		name: v.optional(v.string()),
		serverId: v.optional(v.id("servers")),
	},
	handler: async (ctx, { organizationId, payload, name, serverId }) => {
		await requireMember(ctx, organizationId, "admin");
		if (serverId) await assertImportServer(ctx, organizationId, serverId);
		const projectName = (name ?? payload.project.name).trim();
		if (!projectName) throw new ConvexError("Project name is required");
		if (payload.environments.length > MAX_ENVIRONMENTS) {
			throw new ConvexError("Too many environments in bundle");
		}
		const projectId = await ctx.db.insert("projects", {
			organizationId,
			name: projectName,
			description: payload.project.description,
		});
		if (payload.project.sealedEnv) {
			await putSecret(ctx, {
				organizationId,
				kind: PROJECT_ENV_KIND,
				ownerId: projectId,
				...payload.project.sealedEnv,
			});
		}
		const environmentIdMap: Record<string, Id<"environments">> = {};
		const seen = new Set<string>();
		let hasDefault = false;
		for (const environment of payload.environments) {
			const envName = environment.name.trim();
			if (!envName || seen.has(envName)) {
				throw new ConvexError(`Invalid or duplicate environment "${envName}"`);
			}
			seen.add(envName);
			const isDefault: boolean = environment.isDefault && !hasDefault;
			hasDefault ||= isDefault;
			const environmentId = await ctx.db.insert("environments", {
				organizationId,
				projectId,
				name: envName,
				description: environment.description,
				isDefault,
			});
			environmentIdMap[environment.id] = environmentId;
			if (environment.sealedEnv) {
				await putSecret(ctx, {
					organizationId,
					kind: ENVIRONMENT_ENV_KIND,
					ownerId: environmentId,
					...environment.sealedEnv,
				});
			}
		}
		if (!hasDefault) {
			const environmentId = await ctx.db.insert("environments", {
				organizationId,
				projectId,
				name: seen.has("production") ? "default" : "production",
				isDefault: true,
			});
			environmentIdMap[""] = environmentId;
		}
		for (const tag of payload.tags.slice(0, MAX_TAGS)) {
			const tagName = tag.name.trim();
			if (!tagName) continue;
			const existing = await ctx.db
				.query("tags")
				.withIndex("by_organizationId_and_name", (q) =>
					q.eq("organizationId", organizationId).eq("name", tagName),
				)
				.first();
			const tagId =
				existing?._id ??
				(await ctx.db.insert("tags", {
					organizationId,
					name: tagName,
					color: tag.color,
				}));
			await ctx.db.insert("projectTags", { organizationId, projectId, tagId });
		}
		const warnings = [...payload.warnings];
		for (const section of transferSections) {
			const rows = payload.sections[section.key];
			if (!rows?.length) continue;
			const result = await ctx.runMutation(section.importRows, {
				organizationId,
				projectId,
				environmentIdMap,
				rows,
				serverId,
			});
			warnings.push(...result.warnings);
		}
		const unknownSections = Object.keys(payload.sections).filter(
			(key) => !transferSections.some((section) => section.key === key),
		);
		for (const key of unknownSections) {
			warnings.push(`Section "${key}" is not supported here and was skipped.`);
		}
		return { projectId, warnings };
	},
});

const MAX_DUPLICATE_SERVICES = 200;
const MAX_SERVICES_PER_KIND = 500;

const serviceIdsIn = async (
	ctx: MutationCtx,
	environmentId: Id<"environments">,
): Promise<Set<string>> => {
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
	return new Set(
		[...applications, ...compose, ...databases].map((row) => row._id as string),
	);
};

export const duplicateServiceType = v.union(
	v.literal("application"),
	v.literal("compose"),
	v.literal("libsql"),
	v.literal("mariadb"),
	v.literal("mongo"),
	v.literal("mysql"),
	v.literal("postgres"),
	v.literal("redis"),
);

// What duplicating needs from the source: the selected
// services' app names (export rows are matched by appName, which is unique).
export const loadDuplicateSource = internalQuery({
	args: {
		sourceEnvironmentId: v.id("environments"),
		services: v.array(v.object({ id: v.string(), type: duplicateServiceType })),
	},
	handler: async (ctx, { sourceEnvironmentId, services }) => {
		const environment = await ctx.db.get("environments", sourceEnvironmentId);
		if (!environment) throw new ConvexError("Environment not found");
		const access = await requirePermission(
			ctx,
			environment.organizationId,
			"project",
			"create",
		);
		if (services.length > MAX_DUPLICATE_SERVICES) {
			throw new ConvexError("Too many services selected");
		}
		const appNames: string[] = [];
		for (const service of services) {
			const table =
				service.type === "application"
					? "applications"
					: service.type === "compose"
						? "compose"
						: "databases";
			const id = ctx.db.normalizeId(table, service.id);
			const row = id ? await ctx.db.get(id) : null;
			if (!row || row.environmentId !== sourceEnvironmentId) {
				throw new ConvexError("Service not found in this environment");
			}
			if (!canAccessService(access, row._id)) {
				throw new ConvexError("You don't have access to this service");
			}
			appNames.push(row.appName);
		}
		return {
			organizationId: environment.organizationId,
			projectId: environment.projectId,
			appNames,
		};
	},
});

// Imports the duplicated rows either into an existing environment of the
// organization or into a new project (with a default production
// environment), in one transaction.
export const applyDuplicate = internalMutation({
	args: {
		organizationId: v.string(),
		sourceEnvironmentId: v.id("environments"),
		target: v.union(
			v.object({
				kind: v.literal("environment"),
				environmentId: v.id("environments"),
			}),
			v.object({
				kind: v.literal("newProject"),
				name: v.string(),
				description: v.optional(v.string()),
			}),
		),
		sections: v.record(v.string(), v.array(v.any())),
	},
	handler: async (
		ctx,
		{ organizationId, sourceEnvironmentId, target, sections },
	): Promise<{
		projectId: Id<"projects">;
		environmentId: Id<"environments">;
		warnings: string[];
	}> => {
		const access = await requirePermission(
			ctx,
			organizationId,
			"project",
			"create",
		);
		const source = await ctx.db.get("environments", sourceEnvironmentId);
		if (!source || source.organizationId !== organizationId) {
			throw new ConvexError("Environment not found");
		}
		let projectId: Id<"projects">;
		let environmentId: Id<"environments">;
		if (target.kind === "environment") {
			const environment = await ctx.db.get(
				"environments",
				target.environmentId,
			);
			if (!environment || environment.organizationId !== organizationId) {
				throw new ConvexError("Target environment not found");
			}
			if (!canAccessProject(access, environment.projectId)) {
				throw new ConvexError("You don't have access to this project");
			}
			projectId = environment.projectId;
			environmentId = environment._id;
		} else {
			const name = target.name.trim();
			if (!name) throw new ConvexError("Project name is required");
			projectId = await ctx.db.insert("projects", {
				organizationId,
				name,
				description: target.description,
			});
			environmentId = await ctx.db.insert("environments", {
				organizationId,
				projectId,
				name: "production",
				isDefault: true,
			});
			await grantCreatedAccess(ctx, access, organizationId, {
				projectId,
				environmentId,
			});
		}
		const before = await serviceIdsIn(ctx, environmentId);
		const warnings: string[] = [];
		for (const section of transferSections) {
			const rows = sections[section.key];
			if (!rows?.length) continue;
			const result = await ctx.runMutation(section.importRows, {
				organizationId,
				projectId,
				environmentIdMap: { [sourceEnvironmentId]: environmentId },
				rows,
			});
			warnings.push(...result.warnings);
		}
		for (const serviceId of await serviceIdsIn(ctx, environmentId)) {
			if (!before.has(serviceId)) {
				await grantCreatedAccess(ctx, access, organizationId, { serviceId });
			}
		}
		return { projectId, environmentId, warnings: [...new Set(warnings)] };
	},
});
