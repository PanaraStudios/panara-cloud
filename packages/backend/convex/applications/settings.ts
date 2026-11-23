import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { mutation, query } from "../_generated/server";
import { requireServicePermission } from "../lib/permissions";
import { recordSettingsEvents } from "../lib/serviceEvents";
import { resourceSettings, swarmSettings } from "../lib/serviceSettings";
import { assertSwarmSettingsAllowed } from "../lib/swarmPolicy";
import { canUseProvider } from "../sources/access";
import { DOCKER_PASSWORD_KIND, requireApplication } from "./lib";

// Everything the application page shows: the application (without its
// webhook token) plus the names and addresses of its server, environment
// and project.
export const overview = query({
	args: { applicationId: v.id("applications") },
	handler: async (ctx, { applicationId }) => {
		const app = await ctx.db.get("applications", applicationId);
		if (!app) return null;
		const { userId, role } = await requireServicePermission(
			ctx,
			app,
			"service",
			"read",
		);
		const { refreshToken: _, ...application } = app;
		const environment = await ctx.db.get("environments", app.environmentId);
		const project = await ctx.db.get("projects", app.projectId);
		const server = app.serverId
			? await ctx.db.get("servers", app.serverId)
			: null;
		const settings = await ctx.db
			.query("webServerSettings")
			.withIndex("by_key", (q) => q.eq("key", "instance"))
			.unique();
		let hasGitProviderAccess = true;
		if (app.source?.type === "git" && app.source.git.type !== "git") {
			const provider = await ctx.db.get(
				"gitProviders",
				app.source.git.gitProviderId,
			);
			hasGitProviderAccess =
				provider !== null && canUseProvider(provider, userId, role);
		}
		return {
			application,
			environment: environment && {
				_id: environment._id,
				name: environment.name,
				projectId: environment.projectId,
			},
			project: project && { _id: project._id, name: project.name },
			server: server && {
				_id: server._id,
				name: server.name,
				ipAddress: server.ipAddress,
				serverType: server.serverType,
			},
			panelIp: settings?.serverIp ?? null,
			hasGitProviderAccess,
			hasDockerPassword:
				app.source?.type === "docker" &&
				(await ctx.db
					.query("secrets")
					.withIndex("by_kind_and_ownerId", (q) =>
						q.eq("kind", DOCKER_PASSWORD_KIND).eq("ownerId", applicationId),
					)
					.unique()) !== null,
		};
	},
});

const settingKeys = [
	...Object.keys(swarmSettings),
	...Object.keys(resourceSettings),
] as (keyof typeof swarmSettings | keyof typeof resourceSettings)[];

const settingKey = v.union(
	v.literal(settingKeys[0]),
	...settingKeys.slice(1).map((key) => v.literal(key)),
);

// Swarm and resource settings, one form at a time: the given fields are set
// and the ones in `clear` go back to Docker's defaults. Takes effect on the
// next deploy or reload.
export const updateServiceSettings = mutation({
	args: {
		applicationId: v.id("applications"),
		clear: v.optional(v.array(settingKey)),
		...swarmSettings,
		...resourceSettings,
	},
	handler: async (ctx, { applicationId, clear, ...fields }) => {
		const { app, userId } = await requireApplication(
			ctx,
			applicationId,
			"service",
			"create",
		);
		await assertSwarmSettingsAllowed(
			ctx,
			app.organizationId,
			app.serverId,
			fields,
		);
		const patch: Partial<Doc<"applications">> = {};
		for (const key of clear ?? []) {
			(patch as Record<string, unknown>)[key] = undefined;
		}
		for (const [key, value] of Object.entries(fields)) {
			if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
		}
		await ctx.db.patch("applications", applicationId, patch);
		await recordSettingsEvents(
			ctx,
			"application",
			app,
			userId,
			Object.keys(patch),
		);
	},
});
