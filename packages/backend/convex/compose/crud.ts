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
import { registerRoutingOwner, removeRoutingOwner } from "../infra/routing";
import { encryptSecret } from "../lib/crypto";
import { removeMountsForOwner } from "../lib/mounts";
import {
	canAccessService,
	grantCreatedAccess,
	requireEnvironmentPermission,
	requirePermission,
	requireServiceCreation,
	requireServicePermission,
} from "../lib/permissions";
import { deleteSecret, putSecret, readSecret } from "../lib/secrets";
import {
	recordEnvEvent,
	recordServiceEvent,
	recordSettingsEvents,
} from "../lib/serviceEvents";
import { assertPanelHostTarget } from "../platform/deployTargets";
import { assertGitSourceAccess } from "../sources/lib";
import {
	type ComposeServiceNetwork,
	composeServiceNetwork,
	composeTriggerType,
} from "../tables/compose";
import { composeType } from "../tables/infra";
import { gitSource } from "../tables/sources";
import {
	assertAppNameFree,
	buildAppName,
	COMPOSE_ENV_KIND,
	cancelQueuedJobs,
	DEFAULT_COMPOSE_PATH,
	enqueueComposeJob,
	generateRefreshToken,
	isAdmin,
	loadCompose,
	owner,
	publicCompose,
	validateCommand,
	validateComposeFile,
	validateComposePath,
	validateSuffix,
} from "./lib";

const MAX_LIST = 500;
const MAX_ICON_LENGTH = 128 * 1024;
const CASCADE_BATCH = 100;

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
			.query("compose")
			.withIndex("by_environmentId", (q) =>
				q.eq("environmentId", environmentId),
			)
			.take(MAX_LIST);
		return rows
			.filter((row) => canAccessService(access, row._id))
			.map((row) => publicCompose(row, access.role));
	},
});

export const get = query({
	args: { composeId: v.id("compose") },
	handler: async (ctx, { composeId }) => {
		const compose = await ctx.db.get("compose", composeId);
		if (!compose) return null;
		const { role } = await requireServicePermission(
			ctx,
			compose,
			"service",
			"read",
		);
		return publicCompose(compose, role);
	},
});

// A compose service: the row plus the server, environment and project
// names its page shows.
export const one = query({
	args: { composeId: v.id("compose") },
	handler: async (ctx, { composeId }) => {
		const compose = await ctx.db.get("compose", composeId);
		if (!compose) return null;
		const { role } = await requireServicePermission(
			ctx,
			compose,
			"service",
			"read",
		);
		const [server, environment, project] = await Promise.all([
			compose.serverId ? ctx.db.get("servers", compose.serverId) : null,
			ctx.db.get("environments", compose.environmentId),
			ctx.db.get("projects", compose.projectId),
		]);
		return {
			...publicCompose(compose, role),
			server: server
				? { _id: server._id, name: server.name, ipAddress: server.ipAddress }
				: null,
			environment: environment
				? { _id: environment._id, name: environment.name }
				: null,
			project: project ? { _id: project._id, name: project.name } : null,
		};
	},
});

export const getFile = query({
	args: { composeId: v.id("compose") },
	handler: async (ctx, { composeId }) => {
		const { compose } = await loadCompose(ctx, composeId, "service", "read");
		return await readComposeFile(ctx, compose._id);
	},
});

export const readComposeFile = async (
	ctx: QueryCtx,
	composeId: Id<"compose">,
): Promise<string> => {
	const row = await ctx.db
		.query("composeFiles")
		.withIndex("by_composeId", (q) => q.eq("composeId", composeId))
		.unique();
	return row?.content ?? "";
};

export const writeComposeFile = async (
	ctx: MutationCtx,
	compose: Pick<Doc<"compose">, "_id" | "organizationId">,
	content: string,
) => {
	validateComposeFile(content);
	const row = await ctx.db
		.query("composeFiles")
		.withIndex("by_composeId", (q) => q.eq("composeId", compose._id))
		.unique();
	if (row) {
		await ctx.db.patch("composeFiles", row._id, { content });
	} else {
		await ctx.db.insert("composeFiles", {
			organizationId: compose.organizationId,
			composeId: compose._id,
			content,
		});
	}
};

const assertServerInOrganization = async (
	ctx: MutationCtx,
	organizationId: string,
	serverId: Id<"servers"> | undefined,
) => {
	if (!serverId) return await assertPanelHostTarget(ctx, organizationId);
	const server = await ctx.db.get("servers", serverId);
	if (!server || server.organizationId !== organizationId) {
		throw new ConvexError("Server not found");
	}
	if (server.serverType === "build") {
		throw new ConvexError("Build servers cannot run compose services");
	}
};

const validateServiceNetworks = async (
	ctx: MutationCtx,
	compose: Pick<Doc<"compose">, "organizationId" | "serverId">,
	serviceNetworks: ComposeServiceNetwork[],
) => {
	if (serviceNetworks.length > 100) {
		throw new ConvexError("Too many service networks");
	}
	for (const entry of serviceNetworks) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.serviceName)) {
			throw new ConvexError("Invalid service name");
		}
		for (const networkId of entry.networkIds) {
			const network = await ctx.db.get("networks", networkId);
			if (
				!network ||
				network.organizationId !== compose.organizationId ||
				network.serverId !== compose.serverId
			) {
				throw new ConvexError("Network not found on the compose's server");
			}
		}
	}
	return serviceNetworks;
};

// Template logos are URLs; icons picked or uploaded in the UI are image data
// URLs (as for applications).
const validateIcon = (icon: string | null) => {
	if (!icon) return undefined;
	if (icon.length > MAX_ICON_LENGTH) {
		throw new ConvexError("The icon is too large");
	}
	if (
		!/^data:image\/(svg\+xml|png|jpeg|jpg|webp|gif)[;,]/.test(icon) &&
		!/^https?:\/\/\S+$/.test(icon)
	) {
		throw new ConvexError("The icon must be an image data URL or a URL");
	}
	return icon;
};

export type NewCompose = {
	environmentId: Id<"environments">;
	name: string;
	description?: string;
	appName: string;
	serverId?: Id<"servers">;
	composeType?: "docker-compose" | "stack";
	composeFile?: string;
	icon?: string;
	isolatedDeployment?: boolean;
	requestedBy?: string;
};

// Inserts a raw compose service and registers it for routing. The caller
// has authorized service creation in the environment.
export const insertCompose = async (
	ctx: MutationCtx,
	input: NewCompose,
): Promise<Doc<"compose">> => {
	const environment = await ctx.db.get("environments", input.environmentId);
	if (!environment) throw new ConvexError("Environment not found");
	const name = input.name.trim();
	if (!name) throw new ConvexError("Name is required");
	await assertServerInOrganization(
		ctx,
		environment.organizationId,
		input.serverId,
	);
	await assertAppNameFree(ctx, input.appName);
	const type = input.composeType ?? "docker-compose";
	const composeId = await ctx.db.insert("compose", {
		organizationId: environment.organizationId,
		projectId: environment.projectId,
		environmentId: environment._id,
		serverId: input.serverId,
		name,
		appName: input.appName,
		description: input.description,
		icon: input.icon?.slice(0, 2048),
		composeType: type,
		sourceType: "raw",
		composePath: DEFAULT_COMPOSE_PATH,
		command: "",
		createEnvFile: true,
		randomize: false,
		suffix: "",
		isolatedDeployment: input.isolatedDeployment ?? false,
		isolatedDeploymentsVolume: false,
		pullImages: false,
		autoDeploy: true,
		triggerType: "push",
		refreshToken: generateRefreshToken(),
		status: "idle",
	});
	const compose = (await ctx.db.get("compose", composeId)) as Doc<"compose">;
	await writeComposeFile(ctx, compose, input.composeFile ?? "");
	await registerRoutingOwner(ctx, {
		organizationId: compose.organizationId,
		owner: owner(composeId),
		serverId: compose.serverId,
		appName: compose.appName,
		composeType: type,
		requestedBy: input.requestedBy,
	});
	await recordServiceEvent(
		ctx,
		"compose",
		compose,
		"lifecycle.created",
		input.requestedBy,
	);
	return compose;
};

const COMPOSE_SETTING_AREAS = {
	composeType: "config.advanced",
	composePath: "config.source",
	command: "config.advanced",
	pullImages: "config.build",
	randomize: "config.advanced",
	suffix: "config.advanced",
	isolatedDeployment: "config.networks",
	isolatedDeploymentsVolume: "config.advanced",
	serviceNetworks: "config.networks",
} as const;

export const create = mutation({
	args: {
		environmentId: v.id("environments"),
		name: v.string(),
		description: v.optional(v.string()),
		appName: v.optional(v.string()),
		serverId: v.optional(v.id("servers")),
		composeType: v.optional(composeType),
		composeFile: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const environment = await ctx.db.get("environments", args.environmentId);
		if (!environment) throw new ConvexError("Environment not found");
		const access = await requireServiceCreation(ctx, environment);
		const compose = await insertCompose(ctx, {
			...args,
			appName: buildAppName(args.appName ?? args.name),
			requestedBy: access.userId,
		});
		await grantCreatedAccess(ctx, access, environment.organizationId, {
			serviceId: compose._id,
		});
		return compose._id;
	},
});

export const update = mutation({
	args: {
		composeId: v.id("compose"),
		name: v.optional(v.string()),
		description: v.optional(v.string()),
		icon: v.optional(v.union(v.string(), v.null())),
		composeType: v.optional(composeType),
		composePath: v.optional(v.string()),
		command: v.optional(v.string()),
		autoDeploy: v.optional(v.boolean()),
		triggerType: v.optional(composeTriggerType),
		pullImages: v.optional(v.boolean()),
		randomize: v.optional(v.boolean()),
		suffix: v.optional(v.string()),
		isolatedDeployment: v.optional(v.boolean()),
		isolatedDeploymentsVolume: v.optional(v.boolean()),
		serviceNetworks: v.optional(v.array(composeServiceNetwork)),
	},
	handler: async (ctx, { composeId, ...fields }) => {
		const { compose, userId } = await loadCompose(
			ctx,
			composeId,
			"service",
			"create",
		);
		const patch: Partial<Doc<"compose">> = {};
		if (fields.name !== undefined) {
			const name = fields.name.trim();
			if (!name) throw new ConvexError("Name is required");
			patch.name = name;
		}
		if (fields.description !== undefined)
			patch.description = fields.description;
		if (fields.icon !== undefined) patch.icon = validateIcon(fields.icon);
		if (fields.composeType !== undefined)
			patch.composeType = fields.composeType;
		if (fields.composePath !== undefined)
			patch.composePath = validateComposePath(fields.composePath.trim());
		if (fields.command !== undefined)
			patch.command = validateCommand(fields.command);
		if (fields.autoDeploy !== undefined) patch.autoDeploy = fields.autoDeploy;
		if (fields.triggerType !== undefined)
			patch.triggerType = fields.triggerType;
		if (fields.pullImages !== undefined) patch.pullImages = fields.pullImages;
		if (fields.randomize !== undefined) patch.randomize = fields.randomize;
		if (fields.suffix !== undefined)
			patch.suffix = validateSuffix(fields.suffix.trim());
		if (fields.isolatedDeployment !== undefined)
			patch.isolatedDeployment = fields.isolatedDeployment;
		if (fields.isolatedDeploymentsVolume !== undefined)
			patch.isolatedDeploymentsVolume = fields.isolatedDeploymentsVolume;
		if (fields.serviceNetworks !== undefined) {
			patch.serviceNetworks = await validateServiceNetworks(
				ctx,
				compose,
				fields.serviceNetworks,
			);
		}
		const randomize = patch.randomize ?? compose.randomize;
		const suffix = patch.suffix ?? compose.suffix;
		if (randomize && !suffix) {
			throw new ConvexError("A suffix is required to randomize the compose");
		}
		await ctx.db.patch("compose", composeId, patch);
		await recordSettingsEvents(
			ctx,
			"compose",
			compose,
			userId,
			Object.keys(patch),
			{ newName: patch.name, areas: COMPOSE_SETTING_AREAS },
		);
		if (patch.composeType && patch.composeType !== compose.composeType) {
			await registerRoutingOwner(ctx, {
				organizationId: compose.organizationId,
				owner: owner(composeId),
				serverId: compose.serverId,
				appName: compose.appName,
				composeType: patch.composeType,
				requestedBy: userId,
			});
		}
	},
});

export const saveFile = mutation({
	args: { composeId: v.id("compose"), composeFile: v.string() },
	handler: async (ctx, { composeId, composeFile }) => {
		const { compose, userId } = await loadCompose(
			ctx,
			composeId,
			"service",
			"create",
		);
		await writeComposeFile(ctx, compose, composeFile);
		await recordServiceEvent(
			ctx,
			"compose",
			compose,
			"config.composeFile",
			userId,
		);
	},
});

export const composeSource = v.union(
	v.object({ type: v.literal("raw") }),
	v.object({
		type: v.literal("git"),
		gitSource,
		composePath: v.optional(v.string()),
	}),
);

export const setSource = mutation({
	args: { composeId: v.id("compose"), source: composeSource },
	handler: async (ctx, { composeId, source }) => {
		const { compose, userId } = await loadCompose(
			ctx,
			composeId,
			"service",
			"create",
		);
		await recordServiceEvent(ctx, "compose", compose, "config.source", userId, {
			to: source.type,
		});
		if (source.type === "raw") {
			await ctx.db.patch("compose", composeId, {
				sourceType: "raw",
				gitSource: undefined,
				gitProviderId: undefined,
			});
			return;
		}
		await assertGitSourceAccess(ctx, compose.organizationId, source.gitSource);
		await ctx.db.patch("compose", composeId, {
			sourceType: "git",
			gitSource: source.gitSource,
			gitProviderId:
				source.gitSource.type === "git"
					? undefined
					: source.gitSource.gitProviderId,
			composePath: validateComposePath(
				(source.composePath ?? compose.composePath).trim(),
			),
		});
	},
});

export const getEnv = query({
	args: { composeId: v.id("compose") },
	handler: async (ctx, { composeId }) => {
		const { compose } = await loadCompose(ctx, composeId, "envVars", "read");
		return (await readSecret(ctx, COMPOSE_ENV_KIND, compose._id)) ?? "";
	},
});

export const setEnv = action({
	args: {
		composeId: v.id("compose"),
		env: v.string(),
		createEnvFile: v.optional(v.boolean()),
	},
	handler: async (ctx, { composeId, env, createEnvFile }) => {
		if (env.length > 256 * 1024) {
			throw new ConvexError("Environment is too large");
		}
		await ctx.runMutation(internal.compose.crud.storeEnv, {
			composeId,
			createEnvFile,
			...(await encryptSecret(env)),
		});
	},
});

export const storeEnv = internalMutation({
	args: {
		composeId: v.id("compose"),
		createEnvFile: v.optional(v.boolean()),
		iv: v.string(),
		ciphertext: v.string(),
	},
	handler: async (ctx, { composeId, createEnvFile, iv, ciphertext }) => {
		const { compose, userId } = await loadCompose(
			ctx,
			composeId,
			"envVars",
			"write",
		);
		await recordEnvEvent(ctx, "compose", compose, userId, [
			{ kind: COMPOSE_ENV_KIND, label: "env", next: { iv, ciphertext } },
		]);
		await putSecret(ctx, {
			organizationId: compose.organizationId,
			kind: COMPOSE_ENV_KIND,
			ownerId: composeId,
			iv,
			ciphertext,
		});
		if (createEnvFile !== undefined) {
			await ctx.db.patch("compose", composeId, { createEnvFile });
		}
	},
});

export const regenerateRefreshToken = mutation({
	args: { composeId: v.id("compose") },
	handler: async (ctx, { composeId }) => {
		const { compose, userId, role } = await loadCompose(
			ctx,
			composeId,
			"service",
			"create",
		);
		const refreshToken = generateRefreshToken();
		await ctx.db.patch("compose", composeId, { refreshToken });
		await recordServiceEvent(ctx, "compose", compose, "config.webhook", userId);
		// Like publicCompose: members never see the webhook token.
		return isAdmin(role) ? refreshToken : null;
	},
});

export const move = mutation({
	args: {
		composeId: v.id("compose"),
		targetEnvironmentId: v.id("environments"),
	},
	handler: async (ctx, { composeId, targetEnvironmentId }) => {
		const { compose, userId } = await loadCompose(
			ctx,
			composeId,
			"service",
			"create",
		);
		const target = await ctx.db.get("environments", targetEnvironmentId);
		if (!target || target.organizationId !== compose.organizationId) {
			throw new ConvexError("Environment not found");
		}
		await requireEnvironmentPermission(ctx, target, "environment", "read");
		await ctx.db.patch("compose", composeId, {
			environmentId: target._id,
			projectId: target.projectId,
		});
		await recordServiceEvent(ctx, "compose", compose, "config.moved", userId, {
			to: target.name,
		});
	},
});

export const remove = mutation({
	args: {
		composeId: v.id("compose"),
		deleteVolumes: v.optional(v.boolean()),
	},
	handler: async (ctx, { composeId, deleteVolumes }) => {
		const compose = await ctx.db.get("compose", composeId);
		if (!compose) return;
		const { userId } = await requireServicePermission(
			ctx,
			compose,
			"service",
			"delete",
		);
		await destroyCompose(ctx, compose, {
			deleteVolumes: deleteVolumes ?? false,
			requestedBy: userId,
		});
	},
});

const destroyCompose = async (
	ctx: MutationCtx,
	compose: Doc<"compose">,
	options: { deleteVolumes: boolean; requestedBy?: string },
) => {
	const composeId = compose._id;
	await cancelQueuedJobs(ctx, composeId);
	await ctx.db.delete("compose", composeId);
	const file = await ctx.db
		.query("composeFiles")
		.withIndex("by_composeId", (q) => q.eq("composeId", composeId))
		.unique();
	if (file) await ctx.db.delete("composeFiles", file._id);
	await deleteSecret(ctx, COMPOSE_ENV_KIND, composeId);
	await removeMountsForOwner(ctx, owner(composeId));
	await removeRoutingOwner(ctx, owner(composeId), options.requestedBy);
	await ctx.scheduler.runAfter(0, internal.platform.schedules.removeForTarget, {
		targetId: composeId,
	});
	await ctx.scheduler.runAfter(0, internal.databases.backups.removeForOwner, {
		kind: "compose",
		id: composeId,
	});
	await ctx.scheduler.runAfter(
		0,
		internal.databases.volumeBackups.removeForOwner,
		{
			kind: "compose",
			id: composeId,
		},
	);
	await ctx.scheduler.runAfter(0, internal.compose.crud.cascadeDelete, {
		composeId,
	});
	await enqueueComposeJob(
		ctx,
		compose,
		{
			kind: "compose.remove",
			appName: compose.appName,
			composeType: compose.composeType,
			deleteVolumes: options.deleteVolumes,
		},
		{ requestedBy: options.requestedBy, idempotent: true, maxAttempts: 3 },
	);
};

const ENVIRONMENT_CASCADE_BATCH = 20;

// Cascade for a deleted environment (or project). Volumes are kept.
export const removeForEnvironment = internalMutation({
	args: { environmentId: v.id("environments") },
	handler: async (ctx, { environmentId }) => {
		const batch = await ctx.db
			.query("compose")
			.withIndex("by_environmentId", (q) =>
				q.eq("environmentId", environmentId),
			)
			.take(ENVIRONMENT_CASCADE_BATCH);
		for (const compose of batch) {
			await destroyCompose(ctx, compose, { deleteVolumes: false });
		}
		if (batch.length === ENVIRONMENT_CASCADE_BATCH) {
			await ctx.scheduler.runAfter(
				0,
				internal.compose.crud.removeForEnvironment,
				{
					environmentId,
				},
			);
		}
	},
});

export const cascadeDelete = internalMutation({
	args: { composeId: v.id("compose") },
	handler: async (ctx, { composeId }) => {
		const ops = await ctx.db
			.query("composeOps")
			.withIndex("by_composeId", (q) => q.eq("composeId", composeId))
			.take(CASCADE_BATCH);
		for (const op of ops) await ctx.db.delete("composeOps", op._id);
		const deployments = await ctx.db
			.query("deployments")
			.withIndex("by_target", (q) =>
				q.eq("target.kind", "compose").eq("target.id", composeId),
			)
			.take(CASCADE_BATCH);
		for (const row of deployments) await ctx.db.delete("deployments", row._id);
		if (ops.length + deployments.length > 0) {
			await ctx.scheduler.runAfter(0, internal.compose.crud.cascadeDelete, {
				composeId,
			});
		}
	},
});
