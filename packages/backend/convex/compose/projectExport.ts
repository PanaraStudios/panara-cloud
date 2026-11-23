import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import {
	exportRouting,
	importRouting,
	routingRow,
} from "../infra/routingExport";
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
import { composeTriggerType } from "../tables/compose";
import { composeType } from "../tables/infra";
import { insertCompose, readComposeFile } from "./crud";
import {
	buildAppName,
	COMPOSE_ENV_KIND,
	owner,
	validateCommand,
	validateComposeFile,
	validateComposePath,
	validateSuffix,
} from "./lib";

const SECRET_KINDS: Record<string, string> = { env: COMPOSE_ENV_KIND };

const rowFields = {
	environmentId: v.string(),
	name: v.string(),
	appName: v.string(),
	description: v.optional(v.string()),
	icon: v.optional(v.string()),
	composeType,
	sourceType: v.union(v.literal("raw"), v.literal("git")),
	gitSource: v.optional(gitSourceRow),
	composePath: v.string(),
	composeFile: v.string(),
	command: v.string(),
	createEnvFile: v.boolean(),
	randomize: v.boolean(),
	suffix: v.string(),
	isolatedDeployment: v.boolean(),
	isolatedDeploymentsVolume: v.boolean(),
	pullImages: v.boolean(),
	autoDeploy: v.boolean(),
	triggerType: composeTriggerType,
	mounts: v.array(mountRow),
	routing: routingRow,
	links: linksRow,
	warnings: v.array(v.string()),
};

const exportRow = v.object({ ...rowFields, secrets: plainSecrets });
const importRow = v.object({ ...rowFields, sealedSecrets });

type ExportRow = typeof exportRow.type;

const exportWarnings = (
	compose: Doc<"compose">,
	skippedFiles: number,
	includeLinks: boolean,
) => {
	const warnings: string[] = [];
	if (!includeLinks && compose.serviceNetworks?.length) {
		warnings.push(
			`"${compose.name}" attached services to networks; attach them again.`,
		);
	}
	if (skippedFiles > 0) {
		warnings.push(
			`"${compose.name}" has ${skippedFiles} file mount(s) that are only exported with a passphrase.`,
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
			const services = await ctx.db
				.query("compose")
				.withIndex("by_environmentId", (q) =>
					q.eq("environmentId", environment._id),
				)
				.take(MAX_SECTION_ROWS);
			for (const compose of services) {
				const { mounts, skippedFiles } = await exportMounts(
					ctx,
					owner(compose._id),
					includeSecrets,
				);
				rows.push({
					environmentId: environment._id,
					name: compose.name,
					appName: compose.appName,
					description: compose.description,
					icon: compose.icon,
					composeType: compose.composeType,
					sourceType: compose.sourceType,
					gitSource: compose.gitSource
						? exportGitSource(compose.gitSource, includeLinks)
						: undefined,
					composePath: compose.composePath,
					composeFile:
						compose.sourceType === "raw"
							? await readComposeFile(ctx, compose._id)
							: "",
					command: compose.command,
					createEnvFile: compose.createEnvFile,
					randomize: compose.randomize,
					suffix: compose.suffix,
					isolatedDeployment: compose.isolatedDeployment,
					isolatedDeploymentsVolume: compose.isolatedDeploymentsVolume,
					pullImages: compose.pullImages,
					autoDeploy: compose.autoDeploy,
					triggerType: compose.triggerType,
					mounts,
					routing: await exportRouting(ctx, owner(compose._id), false),
					links: includeLinks
						? {
								serverId: compose.serverId,
								serviceNetworks: compose.serviceNetworks,
							}
						: undefined,
					warnings: exportWarnings(compose, skippedFiles, includeLinks),
					...(includeSecrets
						? {
								secrets: await exportSecrets(ctx, compose._id, SECRET_KINDS),
							}
						: {}),
				});
			}
		}
		return rows;
	},
});

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
			if (!name) throw new ConvexError("Compose name is required");
			warnings.push(...row.warnings.slice(0, 10).map((w) => w.slice(0, 500)));
			const environmentId = mapEnvironment(environmentIdMap, row.environmentId);
			const environment = environmentId
				? await ctx.db.get("environments", environmentId)
				: null;
			if (!environment || environment.projectId !== projectId) {
				warnings.push(`"${name}" belongs to an unknown environment; skipped.`);
				continue;
			}
			const gitSource =
				row.sourceType === "git" && row.gitSource
					? await importGitSource(
							ctx,
							organizationId,
							row.gitSource,
							name,
							warnings,
						)
					: null;
			const suffix = validateSuffix(row.suffix.trim());
			if (row.randomize && !suffix) {
				throw new ConvexError("A suffix is required to randomize the compose");
			}
			const appName = await uniqueAppName(ctx, () =>
				buildAppName(appNameBase(row.appName)),
			);
			const links = await resolveLinks(
				ctx,
				{ organizationId, links: row.links, serverId, name },
				warnings,
			);
			const compose = await insertCompose(ctx, {
				environmentId: environment._id,
				serverId: links.serverId,
				name,
				description: row.description?.slice(0, 2000),
				appName,
				composeType: row.composeType,
				composeFile: validateComposeFile(row.composeFile),
				icon: row.icon,
				isolatedDeployment: row.isolatedDeployment,
			});
			await ctx.db.patch("compose", compose._id, {
				...(gitSource
					? {
							sourceType: "git" as const,
							gitSource,
							...(gitSource.type !== "git"
								? { gitProviderId: gitSource.gitProviderId }
								: {}),
						}
					: {}),
				...(links.serviceNetworks
					? { serviceNetworks: links.serviceNetworks }
					: {}),
				composePath: validateComposePath(row.composePath.trim()),
				command: validateCommand(row.command),
				createEnvFile: row.createEnvFile,
				randomize: row.randomize,
				suffix,
				isolatedDeploymentsVolume: row.isolatedDeploymentsVolume,
				pullImages: row.pullImages,
				autoDeploy: row.autoDeploy,
				triggerType: row.triggerType,
			});
			await importRouting(
				ctx,
				{
					organizationId,
					owner: owner(compose._id),
					serverId: links.serverId,
					name,
					routing: row.routing,
				},
				warnings,
			);
			await importMounts(ctx, organizationId, owner(compose._id), row.mounts, {
				from: row.appName,
				to: appName,
			});
			await importSecrets(
				ctx,
				organizationId,
				compose._id,
				SECRET_KINDS,
				row.sealedSecrets,
			);
		}
		return { warnings };
	},
});
