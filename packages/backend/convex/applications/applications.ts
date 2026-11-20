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
import { requireInstanceAdmin } from "../infra/access";
import { validateServiceNetworks } from "../infra/networks";
import {
	enqueueDependentSyncs,
	registerRoutingOwner,
	removeRoutingOwner,
} from "../infra/routing";
import { normalizeHost, validatePath, validatePort } from "../infra/validation";
import { encryptSecret } from "../lib/crypto";
import { removeMountsForOwner } from "../lib/mounts";
import {
	canAccessEnvironment,
	canAccessService,
	grantCreatedAccess,
	requirePermission,
	requireServiceCreation,
	requireServicePermission,
} from "../lib/permissions";
import { deleteSecret, putSecret, readSecret } from "../lib/secrets";
import {
	changedFields,
	type EnvApplies,
	recordEnvEvent,
	recordServiceEvent,
	recordSettingsEvents,
} from "../lib/serviceEvents";
import { resourceSettings, swarmSettings } from "../lib/serviceSettings";
import { assertSwarmSettingsAllowed } from "../lib/swarmPolicy";
import { assertPanelHostAllowed } from "../platform/deployTargets";
import { assertGitSourceAccess } from "../sources/lib";
import { certificateType } from "../tables/infra";
import { gitSource } from "../tables/sources";
import {
	APPLICATION_SECRET_KINDS,
	applicationGroup,
	applicationOwner,
	BUILD_ARGS_KIND,
	BUILD_SECRETS_KIND,
	BUILD_TOKEN_REGEX,
	buildAppName,
	buildPartition,
	cancelPendingJobs,
	DOCKER_PASSWORD_KIND,
	deployPartition,
	ENV_KIND,
	enqueueApplicationJob,
	isAppNameTaken,
	isSafeBuildPath,
	MAX_APPLICATIONS_PER_ENVIRONMENT,
	MAX_ENV_LENGTH,
	PREVIEW_BUILD_ARGS_KIND,
	PREVIEW_BUILD_SECRETS_KIND,
	PREVIEW_ENV_KIND,
	previewOwner,
	requireApplication,
} from "./lib";
import { enqueueRollbackImagesRemove } from "./rollbackImages";

const encrypted = v.object({ iv: v.string(), ciphertext: v.string() });

const randomToken = (length = 32) => {
	const alphabet =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	return Array.from(
		crypto.getRandomValues(new Uint8Array(length)),
		(byte) => alphabet[byte % alphabet.length],
	).join("");
};

// Fields users may read: everything except the webhook token.
const publicApplication = (app: Doc<"applications">) => {
	const { refreshToken: _, ...rest } = app;
	return rest;
};

const assertServer = async (
	ctx: QueryCtx,
	organizationId: string,
	serverId: Id<"servers">,
) => {
	const server = await ctx.db.get("servers", serverId);
	if (!server || server.organizationId !== organizationId) {
		throw new ConvexError("Server not found");
	}
	return server;
};

const assertRegistry = async (
	ctx: QueryCtx,
	organizationId: string,
	registryId: Id<"registries"> | undefined,
) => {
	if (!registryId) return;
	const registry = await ctx.db.get("registries", registryId);
	if (!registry || registry.organizationId !== organizationId) {
		throw new ConvexError("Registry not found");
	}
};

// The panel host is shared by the whole instance, so (like infra) only
// instance administrators may deploy onto it.
const assertTargets = async (
	ctx: QueryCtx,
	organizationId: string,
	targets: {
		serverId?: Id<"servers">;
		buildServerId?: Id<"servers">;
		buildRegistryId?: Id<"registries">;
		registryId?: Id<"registries">;
	},
) => {
	if (targets.serverId) {
		await assertServer(ctx, organizationId, targets.serverId);
	} else {
		const { organizationId: root } = await requireInstanceAdmin(ctx);
		if (root !== organizationId) {
			throw new ConvexError("Select a server to deploy to");
		}
	}
	if (targets.buildServerId) {
		await assertServer(ctx, organizationId, targets.buildServerId);
		if (!targets.buildRegistryId && !targets.registryId) {
			throw new ConvexError(
				"A build server needs a registry to hand the image to the deploy server",
			);
		}
	}
	await assertRegistry(ctx, organizationId, targets.buildRegistryId);
	await assertRegistry(ctx, organizationId, targets.registryId);
};

const MAX_ICON_LENGTH = 128 * 1024;

const validateIcon = (icon: string | null) => {
	if (!icon) return undefined;
	if (icon.length > MAX_ICON_LENGTH) {
		throw new ConvexError("The icon is too large");
	}
	if (!/^data:image\/(svg\+xml|png|jpeg|jpg|webp|gif)[;,]/.test(icon)) {
		throw new ConvexError("The icon must be an image data URL");
	}
	return icon;
};

const assertBuildPath = (value: string | undefined, field: string) => {
	if (value && !isSafeBuildPath(value)) {
		throw new ConvexError(
			`${field} can only contain letters, numbers and . _ - @ + / (no spaces, no leading '-', no '..')`,
		);
	}
};

const assertBuildToken = (value: string | undefined, field: string) => {
	if (value && !BUILD_TOKEN_REGEX.test(value)) {
		throw new ConvexError(
			`${field} can only contain letters, numbers, dots, underscores and hyphens`,
		);
	}
};

const defaults = {
	build: {
		type: "nixpacks" as const,
		dockerfile: "Dockerfile",
		isStaticSpa: false,
		railpackVersion: "0.15.4",
		herokuVersion: "24",
		cleanCache: false,
		createEnvFile: true,
	},
	preview: {
		enabled: false,
		port: 3000,
		https: false,
		path: "/",
		certificateType: "none" as const,
		limit: 3,
		labels: [],
		requireCollaboratorPermissions: true,
	},
	rollback: { enabled: false, keep: 5 },
};

export const create = mutation({
	args: {
		environmentId: v.id("environments"),
		name: v.string(),
		appName: v.optional(v.string()),
		description: v.optional(v.string()),
		serverId: v.optional(v.id("servers")),
	},
	handler: async (ctx, args) => {
		const environment = await ctx.db.get("environments", args.environmentId);
		if (!environment) throw new ConvexError("Environment not found");
		const access = await requireServiceCreation(ctx, environment);
		const { userId } = access;
		const name = args.name.trim();
		if (!name) throw new ConvexError("Name is required");
		await assertTargets(ctx, environment.organizationId, {
			serverId: args.serverId,
		});
		if (!args.serverId) await assertPanelHostAllowed(ctx);
		const existing = await ctx.db
			.query("applications")
			.withIndex("by_environmentId", (q) =>
				q.eq("environmentId", args.environmentId),
			)
			.take(MAX_APPLICATIONS_PER_ENVIRONMENT);
		if (existing.length >= MAX_APPLICATIONS_PER_ENVIRONMENT) {
			throw new ConvexError("Too many applications in this environment");
		}
		const appName = buildAppName("app", args.appName);
		if (await isAppNameTaken(ctx, appName)) {
			throw new ConvexError("Application with this 'AppName' already exists");
		}
		const applicationId = await ctx.db.insert("applications", {
			organizationId: environment.organizationId,
			projectId: environment.projectId,
			environmentId: environment._id,
			name,
			appName,
			description: args.description,
			serverId: args.serverId,
			build: defaults.build,
			replicas: 1,
			autoDeploy: true,
			triggerType: "push",
			refreshToken: randomToken(),
			preview: defaults.preview,
			rollback: defaults.rollback,
			status: "idle",
		});
		await registerRoutingOwner(ctx, {
			organizationId: environment.organizationId,
			owner: applicationOwner(applicationId),
			serverId: args.serverId,
			appName,
			requestedBy: userId,
		});
		await grantCreatedAccess(ctx, access, environment.organizationId, {
			serviceId: applicationId,
		});
		await recordServiceEvent(
			ctx,
			"application",
			{ _id: applicationId, organizationId: environment.organizationId },
			"lifecycle.created",
			userId,
		);
		return applicationId;
	},
});

export const get = query({
	args: { applicationId: v.id("applications") },
	handler: async (ctx, { applicationId }) => {
		const app = await ctx.db.get("applications", applicationId);
		if (!app) return null;
		await requireServicePermission(ctx, app, "service", "read");
		return publicApplication(app);
	},
});

export const listByEnvironment = query({
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
		const apps = await ctx.db
			.query("applications")
			.withIndex("by_environmentId", (q) =>
				q.eq("environmentId", environmentId),
			)
			.take(MAX_APPLICATIONS_PER_ENVIRONMENT);
		return apps
			.filter((app) => canAccessService(access, app._id))
			.map((app) => ({
				_id: app._id,
				_creationTime: app._creationTime,
				name: app.name,
				appName: app.appName,
				description: app.description,
				serverId: app.serverId,
				sourceType: app.source?.type ?? null,
				status: app.status,
			}));
	},
});

export const update = mutation({
	args: {
		applicationId: v.id("applications"),
		name: v.optional(v.string()),
		description: v.optional(v.string()),
		command: v.optional(v.union(v.string(), v.null())),
		args: v.optional(v.array(v.string())),
		replicas: v.optional(v.number()),
		autoDeploy: v.optional(v.boolean()),
		triggerType: v.optional(v.union(v.literal("push"), v.literal("tag"))),
		icon: v.optional(v.union(v.string(), v.null())),
		cleanCache: v.optional(v.boolean()),
		...swarmSettings,
		...resourceSettings,
	},
	handler: async (
		ctx,
		{ applicationId, command, icon, cleanCache, ...fields },
	) => {
		const { app, userId } = await requireApplication(
			ctx,
			applicationId,
			"service",
			"create",
		);
		const name = fields.name?.trim();
		if (fields.name !== undefined && !name) {
			throw new ConvexError("Name is required");
		}
		if (
			fields.replicas !== undefined &&
			(!Number.isInteger(fields.replicas) ||
				fields.replicas < 0 ||
				fields.replicas > 1000)
		) {
			throw new ConvexError("Replicas must be between 0 and 1000");
		}
		await assertSwarmSettingsAllowed(
			ctx,
			app.organizationId,
			app.serverId,
			fields,
		);
		const patch: Partial<Doc<"applications">> = {};
		for (const [key, value] of Object.entries(fields)) {
			if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
		}
		if (name) patch.name = name;
		if (command !== undefined) patch.command = command?.trim() || undefined;
		if (icon !== undefined) patch.icon = validateIcon(icon);
		if (cleanCache !== undefined) patch.build = { ...app.build, cleanCache };
		await ctx.db.patch("applications", applicationId, patch);
		await recordSettingsEvents(
			ctx,
			"application",
			app,
			userId,
			Object.keys(patch),
			{ newName: patch.name },
		);
	},
});

export const updateTargets = mutation({
	args: {
		applicationId: v.id("applications"),
		serverId: v.optional(v.id("servers")),
		buildServerId: v.optional(v.id("servers")),
		buildRegistryId: v.optional(v.id("registries")),
		registryId: v.optional(v.id("registries")),
	},
	handler: async (ctx, { applicationId, ...targets }) => {
		const { app, userId } = await requireApplication(
			ctx,
			applicationId,
			"service",
			"create",
		);
		const buildServerId =
			targets.buildServerId === targets.serverId
				? undefined
				: targets.buildServerId;
		await assertTargets(ctx, app.organizationId, {
			...targets,
			buildServerId,
		});
		await ctx.db.patch("applications", applicationId, {
			serverId: targets.serverId,
			buildServerId,
			buildRegistryId: targets.buildRegistryId,
			registryId: targets.registryId,
		});
		await recordServiceEvent(ctx, "application", app, "config.server", userId, {
			fields: Object.keys(targets),
		});
		if (app.serverId !== targets.serverId) {
			await registerRoutingOwner(ctx, {
				organizationId: app.organizationId,
				owner: applicationOwner(applicationId),
				serverId: targets.serverId,
				appName: app.appName,
				requestedBy: userId,
			});
			const previews = await ctx.db
				.query("applicationPreviews")
				.withIndex("by_applicationId", (q) =>
					q.eq("applicationId", applicationId),
				)
				.take(100);
			for (const preview of previews) {
				await registerRoutingOwner(ctx, {
					organizationId: app.organizationId,
					owner: previewOwner(preview._id),
					serverId: targets.serverId,
					appName: preview.appName,
					parent: applicationOwner(applicationId),
					requestedBy: userId,
				});
			}
		}
	},
});

// Sets the extra networks and whether the service leaves
// panara-cloud-network; applied on the next deploy.
export const updateNetworks = mutation({
	args: {
		applicationId: v.id("applications"),
		networkIds: v.array(v.id("networks")),
		detachPanaraCloudNetwork: v.boolean(),
	},
	handler: async (
		ctx,
		{ applicationId, networkIds, detachPanaraCloudNetwork },
	) => {
		const { app, userId } = await requireApplication(
			ctx,
			applicationId,
			"service",
			"create",
		);
		const valid = await validateServiceNetworks(
			ctx,
			app.organizationId,
			app.serverId,
			networkIds,
			detachPanaraCloudNetwork,
		);
		await ctx.db.patch("applications", applicationId, {
			networkIds: valid.length > 0 ? valid : undefined,
			detachPanaraCloudNetwork: detachPanaraCloudNetwork || undefined,
		});
		await recordServiceEvent(
			ctx,
			"application",
			app,
			"config.networks",
			userId,
		);
	},
});

export const saveGitSource = mutation({
	args: {
		applicationId: v.id("applications"),
		source: gitSource,
		triggerType: v.optional(v.union(v.literal("push"), v.literal("tag"))),
	},
	handler: async (ctx, { applicationId, source, triggerType }) => {
		const { app, userId } = await requireApplication(
			ctx,
			applicationId,
			"service",
			"create",
		);
		await assertGitSourceAccess(ctx, app.organizationId, source);
		assertBuildPath(source.buildPath.replace(/^\/+/, ""), "Build path");
		await ctx.db.patch("applications", applicationId, {
			source: { type: "git", git: source },
			gitProviderId: source.type === "git" ? undefined : source.gitProviderId,
			...(triggerType ? { triggerType } : {}),
		});
		await recordServiceEvent(ctx, "application", app, "config.source", userId, {
			to: source.type,
		});
		await deleteSecret(ctx, DOCKER_PASSWORD_KIND, applicationId);
		await deleteDropArchive(ctx, app);
	},
});

// The password is encrypted here; pass undefined to keep the stored one and
// "" to clear it.
export const saveDockerSource = action({
	args: {
		applicationId: v.id("applications"),
		image: v.string(),
		registryUrl: v.optional(v.string()),
		username: v.optional(v.string()),
		password: v.optional(v.string()),
	},
	handler: async (ctx, { password, ...args }): Promise<null> => {
		await ctx.runMutation(
			internal.applications.applications.storeDockerSource,
			{
				...args,
				password:
					password === undefined
						? undefined
						: password === ""
							? null
							: await encryptSecret(password),
			},
		);
		return null;
	},
});

export const storeDockerSource = internalMutation({
	args: {
		applicationId: v.id("applications"),
		image: v.string(),
		registryUrl: v.optional(v.string()),
		username: v.optional(v.string()),
		password: v.optional(v.union(encrypted, v.null())),
	},
	handler: async (
		ctx,
		{ applicationId, image, registryUrl, username, password },
	) => {
		const { app, userId } = await requireApplication(
			ctx,
			applicationId,
			"service",
			"create",
		);
		const trimmed = image.trim();
		if (!trimmed || /\s/.test(trimmed) || trimmed.startsWith("-")) {
			throw new ConvexError("Invalid docker image");
		}
		await ctx.db.patch("applications", applicationId, {
			source: {
				type: "docker",
				image: trimmed,
				registryUrl: registryUrl?.trim() || undefined,
				username: username?.trim() || undefined,
			},
			gitProviderId: undefined,
		});
		// Reloads and redeploys run the configured image, so they apply this too.
		await recordServiceEvent(ctx, "application", app, "config.source", userId, {
			to: "docker",
			fields: password === undefined ? undefined : ["registryPassword"],
			reapply: "spec",
		});
		if (password === null) {
			await deleteSecret(ctx, DOCKER_PASSWORD_KIND, applicationId);
		} else if (password) {
			await putSecret(ctx, {
				organizationId: app.organizationId,
				kind: DOCKER_PASSWORD_KIND,
				ownerId: applicationId,
				...password,
			});
		}
		await deleteDropArchive(ctx, app);
	},
});

export const disconnectSource = mutation({
	args: { applicationId: v.id("applications") },
	handler: async (ctx, { applicationId }) => {
		const { app, userId } = await requireApplication(
			ctx,
			applicationId,
			"service",
			"create",
		);
		await recordServiceEvent(ctx, "application", app, "config.source", userId, {
			action: "remove",
		});
		await ctx.db.patch("applications", applicationId, {
			source: undefined,
			gitProviderId: undefined,
		});
		await deleteSecret(ctx, DOCKER_PASSWORD_KIND, applicationId);
		await deleteDropArchive(ctx, app);
	},
});

export const deleteDropArchive = async (
	ctx: MutationCtx,
	app: Doc<"applications">,
) => {
	if (app.source?.type === "drop" && app.source.storageId) {
		await ctx.storage.delete(app.source.storageId);
	}
};

export const saveBuildType = mutation({
	args: {
		applicationId: v.id("applications"),
		type: v.union(
			v.literal("dockerfile"),
			v.literal("heroku_buildpacks"),
			v.literal("paketo_buildpacks"),
			v.literal("nixpacks"),
			v.literal("static"),
			v.literal("railpack"),
		),
		dockerfile: v.optional(v.string()),
		dockerContextPath: v.optional(v.string()),
		dockerBuildStage: v.optional(v.string()),
		publishDirectory: v.optional(v.string()),
		isStaticSpa: v.optional(v.boolean()),
		railpackVersion: v.optional(v.string()),
		herokuVersion: v.optional(v.string()),
		cleanCache: v.optional(v.boolean()),
		createEnvFile: v.optional(v.boolean()),
	},
	handler: async (ctx, { applicationId, ...build }) => {
		const { app, userId } = await requireApplication(
			ctx,
			applicationId,
			"service",
			"create",
		);
		const dockerfile = build.dockerfile?.trim() || app.build.dockerfile;
		const dockerContextPath = build.dockerContextPath?.trim() || undefined;
		const publishDirectory = build.publishDirectory?.trim() || undefined;
		const dockerBuildStage = build.dockerBuildStage?.trim() || undefined;
		const railpackVersion =
			build.railpackVersion?.trim() || app.build.railpackVersion;
		const herokuVersion =
			build.herokuVersion?.trim() || app.build.herokuVersion;
		assertBuildPath(dockerfile, "Dockerfile path");
		assertBuildPath(dockerContextPath, "Docker context path");
		assertBuildPath(publishDirectory, "Publish directory");
		assertBuildToken(dockerBuildStage, "Docker build stage");
		assertBuildToken(railpackVersion, "Railpack version");
		assertBuildToken(herokuVersion, "Heroku version");
		await ctx.db.patch("applications", applicationId, {
			build: {
				type: build.type,
				dockerfile,
				dockerContextPath,
				dockerBuildStage,
				publishDirectory,
				isStaticSpa: build.isStaticSpa ?? app.build.isStaticSpa,
				railpackVersion,
				herokuVersion,
				cleanCache: build.cleanCache ?? app.build.cleanCache,
				createEnvFile: build.createEnvFile ?? app.build.createEnvFile,
			},
		});
		await recordServiceEvent(ctx, "application", app, "config.build", userId, {
			fields: changedFields(build),
		});
	},
});

export const getEnvironment = query({
	args: { applicationId: v.id("applications") },
	handler: async (ctx, { applicationId }) => {
		const app = await ctx.db.get("applications", applicationId);
		if (!app) return null;
		await requireServicePermission(ctx, app, "envVars", "read");
		const read = async (kind: string) =>
			(await readSecret(ctx, kind, applicationId)) ?? "";
		return {
			env: await read(ENV_KIND),
			buildArgs: await read(BUILD_ARGS_KIND),
			buildSecrets: await read(BUILD_SECRETS_KIND),
			previewEnv: await read(PREVIEW_ENV_KIND),
			previewBuildArgs: await read(PREVIEW_BUILD_ARGS_KIND),
			previewBuildSecrets: await read(PREVIEW_BUILD_SECRETS_KIND),
		};
	},
});

const envFields = {
	env: v.optional(v.string()),
	buildArgs: v.optional(v.string()),
	buildSecrets: v.optional(v.string()),
	previewEnv: v.optional(v.string()),
	previewBuildArgs: v.optional(v.string()),
	previewBuildSecrets: v.optional(v.string()),
};

const ENV_FIELD_KINDS = {
	env: ENV_KIND,
	buildArgs: BUILD_ARGS_KIND,
	buildSecrets: BUILD_SECRETS_KIND,
	previewEnv: PREVIEW_ENV_KIND,
	previewBuildArgs: PREVIEW_BUILD_ARGS_KIND,
	previewBuildSecrets: PREVIEW_BUILD_SECRETS_KIND,
} as const;

// A reload re-applies the runtime env; build args and secrets need a build,
// and preview variables only reach preview deployments.
const ENV_APPLIES: Record<keyof typeof ENV_FIELD_KINDS, EnvApplies> = {
	env: "spec",
	buildArgs: "build",
	buildSecrets: "build",
	previewEnv: "never",
	previewBuildArgs: "never",
	previewBuildSecrets: "never",
};

// Only the provided fields change; "" clears one.
export const saveEnvironment = action({
	args: { applicationId: v.id("applications"), ...envFields },
	handler: async (ctx, { applicationId, ...fields }): Promise<null> => {
		const values: Record<string, { iv: string; ciphertext: string } | null> =
			{};
		for (const [key, value] of Object.entries(fields)) {
			if (value === undefined) continue;
			if (value.length > MAX_ENV_LENGTH) {
				throw new ConvexError(`${key} is too large`);
			}
			values[key] = value ? await encryptSecret(value) : null;
		}
		await ctx.runMutation(internal.applications.applications.storeEnvironment, {
			applicationId,
			values,
		});
		return null;
	},
});

export const storeEnvironment = internalMutation({
	args: {
		applicationId: v.id("applications"),
		values: v.record(v.string(), v.union(encrypted, v.null())),
	},
	handler: async (ctx, { applicationId, values }) => {
		const { app, userId } = await requireApplication(
			ctx,
			applicationId,
			"envVars",
			"write",
		);
		await recordEnvEvent(
			ctx,
			"application",
			app,
			userId,
			Object.entries(values).flatMap(([label, next]) => {
				const field = label as keyof typeof ENV_FIELD_KINDS;
				const kind = ENV_FIELD_KINDS[field];
				return kind ? [{ kind, label, next, applies: ENV_APPLIES[field] }] : [];
			}),
		);
		for (const [key, value] of Object.entries(values)) {
			const kind = ENV_FIELD_KINDS[key as keyof typeof ENV_FIELD_KINDS];
			if (!kind) throw new ConvexError(`Unknown field ${key}`);
			if (value === null) {
				await deleteSecret(ctx, kind, applicationId);
			} else {
				await putSecret(ctx, {
					organizationId: app.organizationId,
					kind,
					ownerId: applicationId,
					...value,
				});
			}
		}
	},
});

export const savePreviewSettings = mutation({
	args: {
		applicationId: v.id("applications"),
		enabled: v.boolean(),
		wildcard: v.optional(v.string()),
		port: v.optional(v.number()),
		https: v.optional(v.boolean()),
		path: v.optional(v.string()),
		certificateType: v.optional(certificateType),
		customCertResolver: v.optional(v.string()),
		limit: v.optional(v.number()),
		labels: v.optional(v.array(v.string())),
		requireCollaboratorPermissions: v.optional(v.boolean()),
	},
	handler: async (ctx, { applicationId, ...settings }) => {
		const { app, userId } = await requireApplication(
			ctx,
			applicationId,
			"service",
			"create",
		);
		const wildcard = settings.wildcard?.trim() || undefined;
		if (wildcard) {
			if (!wildcard.startsWith("*.")) {
				throw new ConvexError('The wildcard domain must start with "*."');
			}
			normalizeHost(wildcard.slice(2));
		}
		const limit = settings.limit ?? app.preview.limit;
		if (!Number.isInteger(limit) || limit < 0 || limit > 100) {
			throw new ConvexError("Preview limit must be between 0 and 100");
		}
		const preview = {
			enabled: settings.enabled,
			wildcard,
			port: validatePort(settings.port ?? app.preview.port),
			https: settings.https ?? app.preview.https,
			path: validatePath(settings.path ?? app.preview.path, "Path"),
			certificateType: settings.certificateType ?? app.preview.certificateType,
			customCertResolver:
				settings.customCertResolver?.trim() || app.preview.customCertResolver,
			limit,
			labels: (settings.labels ?? app.preview.labels)
				.map((label) => label.trim())
				.filter(Boolean)
				.slice(0, 50),
			requireCollaboratorPermissions:
				settings.requireCollaboratorPermissions ??
				app.preview.requireCollaboratorPermissions,
		};
		if (preview.certificateType === "custom" && !preview.customCertResolver) {
			throw new ConvexError("A custom certificate needs a resolver name");
		}
		await ctx.db.patch("applications", applicationId, { preview });
		await recordServiceEvent(
			ctx,
			"application",
			app,
			"config.previews",
			userId,
		);
		// Existing previews keep their generated host; port/https/path changes
		// apply to their domain rows.
		const previews = await ctx.db
			.query("applicationPreviews")
			.withIndex("by_applicationId", (q) =>
				q.eq("applicationId", applicationId),
			)
			.take(100);
		for (const row of previews) {
			if (!row.domainId) continue;
			const domain = await ctx.db.get("domains", row.domainId);
			if (!domain) continue;
			await ctx.db.patch("domains", domain._id, {
				port: preview.port,
				https: preview.https,
				path: preview.path,
				certificateType: preview.certificateType,
				customCertResolver: preview.customCertResolver,
			});
		}
		if (previews.length > 0) {
			await enqueueDependentSyncs(ctx, applicationOwner(applicationId), userId);
		}
	},
});

export const saveRollbackSettings = mutation({
	args: {
		applicationId: v.id("applications"),
		enabled: v.boolean(),
		keep: v.optional(v.number()),
		registryId: v.optional(v.id("registries")),
	},
	handler: async (ctx, { applicationId, enabled, keep, registryId }) => {
		const { app, userId } = await requireApplication(
			ctx,
			applicationId,
			"service",
			"create",
		);
		const count = keep ?? app.rollback.keep;
		if (!Number.isInteger(count) || count < 1 || count > 50) {
			throw new ConvexError("Keep between 1 and 50 rollback images");
		}
		await assertRegistry(ctx, app.organizationId, registryId);
		await ctx.db.patch("applications", applicationId, {
			rollback: { enabled, keep: count, registryId },
		});
		await recordServiceEvent(
			ctx,
			"application",
			app,
			"config.rollbacks",
			userId,
		);
	},
});

const webhookUrl = (token: string) =>
	`${(process.env.CONVEX_SITE_URL ?? "").replace(/\/+$/, "")}/api/deploy/${token}`;

// The URL deploys the application without further auth, so it takes the
// permission to edit the application (its refreshToken).
export const getWebhookUrl = query({
	args: { applicationId: v.id("applications") },
	handler: async (ctx, { applicationId }) => {
		const { app } = await requireApplication(
			ctx,
			applicationId,
			"service",
			"create",
		);
		return webhookUrl(app.refreshToken);
	},
});

export const regenerateRefreshToken = mutation({
	args: { applicationId: v.id("applications") },
	handler: async (ctx, { applicationId }) => {
		const { app, userId } = await requireApplication(
			ctx,
			applicationId,
			"service",
			"create",
		);
		const refreshToken = randomToken();
		await ctx.db.patch("applications", applicationId, { refreshToken });
		await recordServiceEvent(ctx, "application", app, "config.webhook", userId);
		return webhookUrl(refreshToken);
	},
});

export const move = mutation({
	args: {
		applicationId: v.id("applications"),
		environmentId: v.id("environments"),
	},
	handler: async (ctx, { applicationId, environmentId }) => {
		const { app, access, userId } = await requireApplication(
			ctx,
			applicationId,
			"service",
			"create",
		);
		const environment = await ctx.db.get("environments", environmentId);
		if (!environment || environment.organizationId !== app.organizationId) {
			throw new ConvexError("Environment not found");
		}
		if (!canAccessEnvironment(access, environmentId)) {
			throw new ConvexError("You don't have access to this environment");
		}
		await ctx.db.patch("applications", applicationId, {
			environmentId,
			projectId: environment.projectId,
		});
		await recordServiceEvent(ctx, "application", app, "config.moved", userId, {
			to: environment.name,
		});
	},
});

export const remove = mutation({
	args: { applicationId: v.id("applications") },
	handler: async (ctx, { applicationId }) => {
		const app = await ctx.db.get("applications", applicationId);
		if (!app) return;
		const { userId } = await requireServicePermission(
			ctx,
			app,
			"service",
			"delete",
		);
		await destroyApplication(ctx, app, userId);
	},
});

const destroyApplication = async (
	ctx: MutationCtx,
	app: Doc<"applications">,
	userId?: string,
) => {
	const applicationId = app._id;
	await ctx.db.delete("applications", applicationId);
	const group = applicationGroup(applicationId);
	await cancelPendingJobs(ctx, group);
	const rollbacks = await ctx.db
		.query("applicationRollbacks")
		.withIndex("by_applicationId_and_version", (q) =>
			q.eq("applicationId", applicationId),
		)
		.take(100);
	await enqueueRollbackImagesRemove(ctx, app, rollbacks, userId);
	await removeRoutingOwner(ctx, applicationOwner(applicationId), userId);
	await removeMountsForOwner(ctx, applicationOwner(applicationId));
	for (const kind of APPLICATION_SECRET_KINDS) {
		await deleteSecret(ctx, kind, applicationId);
	}
	await deleteDropArchive(ctx, app);
	const deploy = deployPartition(app);
	const build = buildPartition(app);
	for (const partition of new Set([deploy, build])) {
		await enqueueApplicationJob(ctx, {
			organizationId: app.organizationId,
			partition,
			group,
			spec: {
				kind: "application.remove",
				appName: app.appName,
				removeService: partition === deploy,
			},
			idempotent: true,
			requestedBy: userId,
		});
	}
	await ctx.scheduler.runAfter(0, internal.platform.schedules.removeForTarget, {
		targetId: applicationId,
	});
	await ctx.scheduler.runAfter(
		0,
		internal.databases.volumeBackups.removeForOwner,
		{
			kind: "application",
			id: applicationId,
		},
	);
	await ctx.scheduler.runAfter(
		0,
		internal.applications.cascade.removeApplicationData,
		{ applicationId, deployPartition: deploy, buildPartition: build },
	);
};

const ENVIRONMENT_CASCADE_BATCH = 20;

// Cascade for a deleted environment (or project): removes every application
// in it, in batches.
export const removeForEnvironment = internalMutation({
	args: { environmentId: v.id("environments") },
	handler: async (ctx, { environmentId }) => {
		const batch = await ctx.db
			.query("applications")
			.withIndex("by_environmentId", (q) =>
				q.eq("environmentId", environmentId),
			)
			.take(ENVIRONMENT_CASCADE_BATCH);
		for (const app of batch) await destroyApplication(ctx, app);
		if (batch.length === ENVIRONMENT_CASCADE_BATCH) {
			await ctx.scheduler.runAfter(
				0,
				internal.applications.applications.removeForEnvironment,
				{ environmentId },
			);
		}
	},
});
