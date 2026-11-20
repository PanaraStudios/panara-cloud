import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { resourceSettings, swarmSettings } from "../lib/serviceSettings";
import { assertSwarmSettingsAllowed } from "../lib/swarmPolicy";
import {
	appNameBase,
	authorizeExport,
	authorizeImport,
	exportMounts,
	exportSecrets,
	importArgs,
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
import { databaseEngine } from "../tables/databases";
import {
	APP_NAME_REGEX,
	ENGINES,
	ENV_KIND,
	PASSWORD_KIND,
	ROOT_PASSWORD_KIND,
	randomPassword,
	validateIdentifier,
} from "./lib";

const SECRET_KINDS: Record<string, string> = {
	password: PASSWORD_KIND,
	rootPassword: ROOT_PASSWORD_KIND,
	env: ENV_KIND,
};

const rowFields = {
	environmentId: v.string(),
	engine: databaseEngine,
	name: v.string(),
	appName: v.string(),
	description: v.optional(v.string()),
	dockerImage: v.string(),
	databaseName: v.optional(v.string()),
	databaseUser: v.optional(v.string()),
	command: v.optional(v.string()),
	args: v.optional(v.array(v.string())),
	replicas: v.number(),
	replicaSets: v.optional(v.boolean()),
	sqldNode: v.optional(v.union(v.literal("primary"), v.literal("replica"))),
	sqldPrimaryUrl: v.optional(v.string()),
	enableNamespaces: v.optional(v.boolean()),
	...swarmSettings,
	...resourceSettings,
	mounts: v.array(mountRow),
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

const exportWarnings = (
	database: Doc<"databases">,
	skippedFiles: number,
	includeLinks: boolean,
) => {
	const warnings: string[] = [];
	if (
		database.externalPort ||
		database.externalGRPCPort ||
		database.externalAdminPort
	) {
		warnings.push(
			`"${database.name}" was published on external ports; publish it again.`,
		);
	}
	if (!includeLinks && database.networkIds?.length) {
		warnings.push(
			`"${database.name}" was attached to networks; attach them again.`,
		);
	}
	if (skippedFiles > 0) {
		warnings.push(
			`"${database.name}" has ${skippedFiles} file mount(s) that are only exported with a passphrase.`,
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
			const databases = await ctx.db
				.query("databases")
				.withIndex("by_environmentId", (q) =>
					q.eq("environmentId", environment._id),
				)
				.take(MAX_SECTION_ROWS);
			for (const database of databases) {
				const { mounts, skippedFiles } = await exportMounts(
					ctx,
					{ kind: "database", id: database._id },
					includeSecrets,
				);
				rows.push({
					environmentId: environment._id,
					engine: database.engine,
					name: database.name,
					appName: database.appName,
					description: database.description,
					dockerImage: database.dockerImage,
					databaseName: database.databaseName,
					databaseUser: database.databaseUser,
					command: database.command,
					args: database.args,
					replicas: database.replicas,
					replicaSets: database.replicaSets,
					sqldNode: database.sqldNode,
					sqldPrimaryUrl: database.sqldPrimaryUrl,
					enableNamespaces: database.enableNamespaces,
					...pickSettings(database),
					mounts,
					links: includeLinks
						? {
								serverId: database.serverId,
								networkIds: database.networkIds,
								detachPanaraCloudNetwork: database.detachPanaraCloudNetwork,
							}
						: undefined,
					warnings: exportWarnings(database, skippedFiles, includeLinks),
					...(includeSecrets
						? {
								secrets: await exportSecrets(ctx, database._id, SECRET_KINDS),
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
			if (!name) throw new ConvexError("Database name is required");
			warnings.push(...row.warnings.slice(0, 10).map((w) => w.slice(0, 500)));
			const environmentId = mapEnvironment(environmentIdMap, row.environmentId);
			const environment = environmentId
				? await ctx.db.get("environments", environmentId)
				: null;
			if (!environment || environment.projectId !== projectId) {
				warnings.push(`"${name}" belongs to an unknown environment; skipped.`);
				continue;
			}
			const info = ENGINES[row.engine];
			const databaseName = info.hasDatabaseName
				? row.databaseName?.trim() || row.engine
				: undefined;
			const databaseUser = info.hasUser
				? row.databaseUser?.trim() || row.engine
				: undefined;
			if (databaseName) validateIdentifier(databaseName, "Database name");
			if (databaseUser) validateIdentifier(databaseUser, "Database user");
			const dockerImage = row.dockerImage.trim();
			if (
				!dockerImage ||
				/\s/.test(dockerImage) ||
				dockerImage.startsWith("-")
			) {
				throw new ConvexError("Invalid docker image in bundle");
			}
			if (!Number.isInteger(row.replicas) || row.replicas < 0) {
				throw new ConvexError("Replicas must be a whole number");
			}
			const libsql = row.engine === "libsql";
			const sqldNode = libsql ? (row.sqldNode ?? "primary") : undefined;
			const sqldPrimaryUrl = libsql ? row.sqldPrimaryUrl?.trim() : undefined;
			if (sqldNode === "replica" && !sqldPrimaryUrl) {
				throw new ConvexError("A replica needs the primary's URL");
			}
			const base = appNameBase(row.appName)?.toLowerCase();
			const prefix = base && APP_NAME_REGEX.test(base) ? base : row.engine;
			const appName = await uniqueAppName(
				ctx,
				() => `${prefix}-${randomPassword(6).toLowerCase()}`,
			);
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
			const databaseId = await ctx.db.insert("databases", {
				organizationId,
				projectId: environment.projectId,
				environmentId: environment._id,
				serverId: links.serverId,
				...(links.networkIds ? { networkIds: links.networkIds } : {}),
				...(links.detachPanaraCloudNetwork
					? { detachPanaraCloudNetwork: true }
					: {}),
				engine: row.engine,
				name,
				appName,
				description: row.description?.slice(0, 2000),
				dockerImage,
				databaseName,
				databaseUser,
				command: row.command,
				args: row.args,
				replicas: row.replicas,
				replicaSets: row.engine === "mongo" ? !!row.replicaSets : undefined,
				sqldNode,
				sqldPrimaryUrl,
				enableNamespaces: libsql ? !!row.enableNamespaces : undefined,
				status: "idle",
				...pickSettings(row),
			});
			await importMounts(
				ctx,
				organizationId,
				{ kind: "database", id: databaseId },
				row.mounts,
				{ from: row.appName, to: appName },
			);
			const { rootPassword, ...secrets } = row.sealedSecrets ?? {};
			await importSecrets(
				ctx,
				organizationId,
				databaseId,
				SECRET_KINDS,
				info.hasRootPassword && rootPassword
					? { ...secrets, rootPassword }
					: secrets,
			);
			if (!secrets.password) {
				warnings.push(
					`"${name}" has no password in the bundle; set one before deploying.`,
				);
			}
		}
		return { warnings };
	},
});
