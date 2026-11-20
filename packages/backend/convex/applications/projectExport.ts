import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { registerRoutingOwner } from "../infra/routing";
import {
	exportRouting,
	importRouting,
	routingRow,
} from "../infra/routingExport";
import { validatePort } from "../infra/validation";
import { resourceSettings, swarmSettings } from "../lib/serviceSettings";
import { assertSwarmSettingsAllowed } from "../lib/swarmPolicy";
import {
	appNameBase,
	authorizeExport,
	authorizeImport,
	exportGitSource,
	exportMounts,
	exportSecrets,
	gitSourceRow,
	importArgs,
	importGitSource,
	importMounts,
	importSecrets,
	linksRow,
	MAX_SECTION_ROWS,
	mapEnvironment,
	mountRow,
	plainSecrets,
	resolveLinks,
	sealedSecrets,
	transferArgs,
	uniqueAppName,
} from "../platform/lib/transferRows";
import {
	buildSettings,
	previewSettings,
	triggerType,
} from "../tables/applications";
import {
	applicationOwner,
	BUILD_ARGS_KIND,
	BUILD_SECRETS_KIND,
	BUILD_TOKEN_REGEX,
	buildAppName,
	DOCKER_PASSWORD_KIND,
	ENV_KIND,
	isSafeBuildPath,
	PREVIEW_BUILD_ARGS_KIND,
	PREVIEW_BUILD_SECRETS_KIND,
	PREVIEW_ENV_KIND,
} from "./lib";

const SECRET_KINDS: Record<string, string> = {
	env: ENV_KIND,
	buildArgs: BUILD_ARGS_KIND,
	buildSecrets: BUILD_SECRETS_KIND,
	previewEnv: PREVIEW_ENV_KIND,
	previewBuildArgs: PREVIEW_BUILD_ARGS_KIND,
	previewBuildSecrets: PREVIEW_BUILD_SECRETS_KIND,
	dockerPassword: DOCKER_PASSWORD_KIND,
};

const sourceRow = v.union(
	v.object({ type: v.literal("git"), git: gitSourceRow }),
	v.object({
		type: v.literal("docker"),
		image: v.string(),
		registryUrl: v.optional(v.string()),
		username: v.optional(v.string()),
	}),
	v.object({ type: v.literal("drop"), buildPath: v.string() }),
);

const rowFields = {
	environmentId: v.string(),
	name: v.string(),
	appName: v.string(),
	description: v.optional(v.string()),
	source: v.optional(sourceRow),
	build: buildSettings,
	command: v.optional(v.string()),
	args: v.optional(v.array(v.string())),
	replicas: v.number(),
	...swarmSettings,
	...resourceSettings,
	autoDeploy: v.boolean(),
	triggerType,
	preview: previewSettings,
	rollback: v.object({ enabled: v.boolean(), keep: v.number() }),
	mounts: v.array(mountRow),
	routing: routingRow,
	links: linksRow,
	warnings: v.array(v.string()),
};

const exportRow = v.object({ ...rowFields, secrets: plainSecrets });
const importRow = v.object({ ...rowFields, sealedSecrets });

type ExportRow = typeof exportRow.type;

const SETTING_KEYS = [
	...Object.keys(swarmSettings),
	...Object.keys(resourceSettings),
] as (keyof typeof swarmSettings | keyof typeof resourceSettings)[];

const pickSettings = (source: Partial<Record<string, unknown>>) => {
	const result: Record<string, unknown> = {};
	for (const key of SETTING_KEYS) {
		if (source[key] !== undefined) result[key] = source[key];
	}
	return result as Pick<ExportRow, (typeof SETTING_KEYS)[number]>;
};

const sourceOf = (
	app: Doc<"applications">,
	includeLinks: boolean,
): ExportRow["source"] => {
	const source = app.source;
	if (!source) return undefined;
	if (source.type === "git") {
		return { type: "git", git: exportGitSource(source.git, includeLinks) };
	}
	if (source.type === "drop") {
		return { type: "drop", buildPath: source.buildPath };
	}
	return {
		type: "docker",
		image: source.image,
		registryUrl: source.registryUrl,
		username: source.username,
	};
};

const exportWarnings = (
	app: Doc<"applications">,
	skippedFiles: number,
	includeLinks: boolean,
) => {
	const name = app.name;
	const warnings: string[] = [];
	if (!includeLinks && app.buildServerId) {
		warnings.push(
			`"${name}" was built on a build server; select it again after importing.`,
		);
	}
	if (
		!includeLinks &&
		(app.registryId || app.buildRegistryId || app.rollback.registryId)
	) {
		warnings.push(
			`"${name}" uses a registry; select it again after importing.`,
		);
	}
	if (!includeLinks && app.networkIds?.length) {
		warnings.push(`"${name}" was attached to networks; attach them again.`);
	}
	if (app.source?.type === "drop") {
		warnings.push(
			`"${name}" was deployed from an uploaded file, which is not included; upload it again.`,
		);
	}
	if (skippedFiles > 0) {
		warnings.push(
			`"${name}" has ${skippedFiles} file mount(s) that are only exported with a passphrase.`,
		);
	}
	return warnings;
};

export const exportRows = internalQuery({
	args: transferArgs.exportRows,
	returns: v.array(exportRow),
	handler: async (
		ctx,
		{ projectId, environmentIds, includeSecrets, includeLinks = false },
	) => {
		const { environments } = await authorizeExport(
			ctx,
			projectId,
			environmentIds,
		);
		const rows: ExportRow[] = [];
		for (const environment of environments) {
			const apps = await ctx.db
				.query("applications")
				.withIndex("by_environmentId", (q) =>
					q.eq("environmentId", environment._id),
				)
				.take(MAX_SECTION_ROWS);
			for (const app of apps) {
				const owner = applicationOwner(app._id);
				const { mounts, skippedFiles } = await exportMounts(
					ctx,
					owner,
					includeSecrets,
				);
				rows.push({
					environmentId: environment._id,
					name: app.name,
					appName: app.appName,
					description: app.description,
					source: sourceOf(app, includeLinks),
					build: app.build,
					command: app.command,
					args: app.args,
					replicas: app.replicas,
					...pickSettings(app),
					autoDeploy: app.autoDeploy,
					triggerType: app.triggerType,
					preview: app.preview,
					rollback: { enabled: app.rollback.enabled, keep: app.rollback.keep },
					mounts,
					routing: await exportRouting(ctx, owner, includeSecrets),
					links: includeLinks
						? {
								serverId: app.serverId,
								buildServerId: app.buildServerId,
								registryId: app.registryId,
								buildRegistryId: app.buildRegistryId,
								rollbackRegistryId: app.rollback.registryId,
								networkIds: app.networkIds,
								detachPanaraCloudNetwork: app.detachPanaraCloudNetwork,
							}
						: undefined,
					warnings: exportWarnings(app, skippedFiles, includeLinks),
					...(includeSecrets
						? { secrets: await exportSecrets(ctx, app._id, SECRET_KINDS) }
						: {}),
				});
			}
		}
		return rows;
	},
});

const randomToken = (length = 32) => {
	const alphabet =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	return Array.from(
		crypto.getRandomValues(new Uint8Array(length)),
		(byte) => alphabet[byte % alphabet.length],
	).join("");
};

const checkBuild = (build: ExportRow["build"]) => {
	for (const path of [
		build.dockerfile,
		build.dockerContextPath,
		build.publishDirectory,
	]) {
		if (path && !isSafeBuildPath(path)) {
			throw new ConvexError(`Invalid build path in bundle: ${path}`);
		}
	}
	for (const token of [
		build.dockerBuildStage,
		build.railpackVersion,
		build.herokuVersion,
	]) {
		if (token && !BUILD_TOKEN_REGEX.test(token)) {
			throw new ConvexError(`Invalid build setting in bundle: ${token}`);
		}
	}
};

export const importRows = internalMutation({
	args: importArgs(importRow),
	returns: v.object({ warnings: v.array(v.string()) }),
	handler: async (
		ctx,
		{ organizationId, projectId, environmentIdMap, rows, serverId },
	) => {
		await authorizeImport(ctx, organizationId, projectId, rows, serverId);
		const warnings: string[] = [];
		for (const row of rows) {
			const name = row.name.trim().slice(0, 200);
			if (!name) throw new ConvexError("Application name is required");
			warnings.push(...row.warnings.slice(0, 10).map((w) => w.slice(0, 500)));
			const environmentId = mapEnvironment(environmentIdMap, row.environmentId);
			if (!environmentId) {
				warnings.push(`"${name}" belongs to an unknown environment; skipped.`);
				continue;
			}
			checkBuild(row.build);
			if (
				!Number.isInteger(row.replicas) ||
				row.replicas < 0 ||
				row.replicas > 1000
			) {
				throw new ConvexError("Replicas must be between 0 and 1000");
			}
			if (
				!Number.isInteger(row.rollback.keep) ||
				row.rollback.keep < 1 ||
				row.rollback.keep > 50
			) {
				throw new ConvexError("Invalid rollback retention in bundle");
			}
			validatePort(row.preview.port);
			let source: Doc<"applications">["source"];
			if (row.source?.type === "git") {
				const git = await importGitSource(
					ctx,
					organizationId,
					row.source.git,
					name,
					warnings,
				);
				if (git && !isSafeBuildPath(git.buildPath.replace(/^\/+/, ""))) {
					throw new ConvexError("Invalid build path in bundle");
				}
				source = git ? { type: "git", git } : undefined;
			} else if (row.source?.type === "docker") {
				const image = row.source.image.trim();
				if (!image || /\s/.test(image) || image.startsWith("-")) {
					throw new ConvexError("Invalid docker image in bundle");
				}
				source = { ...row.source, image };
			} else if (row.source?.type === "drop") {
				if (!isSafeBuildPath(row.source.buildPath.replace(/^\/+/, ""))) {
					throw new ConvexError("Invalid build path in bundle");
				}
				source = { type: "drop", buildPath: row.source.buildPath };
			}
			const appName = await uniqueAppName(ctx, () =>
				buildAppName("app", appNameBase(row.appName)),
			);
			const environment = await ctx.db.get("environments", environmentId);
			if (environment?.projectId !== projectId) {
				throw new ConvexError("Environment not found");
			}
			const links = await resolveLinks(
				ctx,
				{ organizationId, links: row.links, serverId, name },
				warnings,
			);
			await assertSwarmSettingsAllowed(
				ctx,
				organizationId,
				links.serverId,
				pickSettings(row),
			);
			const applicationId = await ctx.db.insert("applications", {
				organizationId,
				projectId: environment.projectId,
				environmentId,
				name,
				appName,
				description: row.description?.slice(0, 2000),
				serverId: links.serverId,
				buildServerId: links.buildServerId,
				buildRegistryId: links.buildRegistryId,
				registryId: links.registryId,
				...(links.networkIds ? { networkIds: links.networkIds } : {}),
				...(links.detachPanaraCloudNetwork
					? { detachPanaraCloudNetwork: true }
					: {}),
				source,
				...(source?.type === "git" && source.git.type !== "git"
					? { gitProviderId: source.git.gitProviderId }
					: {}),
				build: row.build,
				command: row.command,
				args: row.args,
				replicas: row.replicas,
				...pickSettings(row),
				autoDeploy: row.autoDeploy,
				triggerType: row.triggerType,
				refreshToken: randomToken(),
				preview: row.preview,
				rollback: {
					...row.rollback,
					...(links.rollbackRegistryId
						? { registryId: links.rollbackRegistryId }
						: {}),
				},
				status: "idle",
			});
			const owner = applicationOwner(applicationId);
			await registerRoutingOwner(ctx, {
				organizationId,
				owner,
				serverId: links.serverId,
				appName,
			});
			await importRouting(
				ctx,
				{
					organizationId,
					owner,
					serverId: links.serverId,
					name,
					routing: row.routing,
				},
				warnings,
			);
			await importMounts(ctx, organizationId, owner, row.mounts, {
				from: row.appName,
				to: appName,
			});
			await importSecrets(
				ctx,
				organizationId,
				applicationId,
				SECRET_KINDS,
				row.sealedSecrets,
			);
		}
		return { warnings };
	},
});
