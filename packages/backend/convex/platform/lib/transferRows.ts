import { ConvexError, type GenericValidator, v } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { isAppNameInUse } from "../../lib/appNames";
import {
	addMount,
	listMounts,
	type MountInput,
	type MountOwner,
	mountInput,
} from "../../lib/mounts";
import {
	requirePermission,
	requireProjectPermission,
} from "../../lib/permissions";
import { putSecret, readSecret } from "../../lib/secrets";
import { assertGitSourceInOrganization } from "../../sources/lib";
import type { GitSource } from "../../tables/sources";
import { assertPanelHostTarget } from "../deployTargets";

// Shared plumbing for project export/import sections.
//
// Secrets: exported rows carry `secrets` (plaintext, keyed by a short field
// name) only when the export is passphrase-encrypted. The import action seals
// them into `sealedSecrets` with encryptSecret before the import mutation
// runs, because mutations can't produce unique IVs; import mutations only
// accept `sealedSecrets` and only for the field names their domain lists.

export const MAX_SECTION_ROWS = 500;

export const transferArgs = {
	exportRows: {
		projectId: v.id("projects"),
		environmentIds: v.array(v.id("environments")),
		includeSecrets: v.boolean(),
		// Keep server, registry, network, git provider and SSH key ids in a
		// row's `links`; only for copies inside the same organization.
		includeLinks: v.optional(v.boolean()),
	},
};

export const plainSecrets = v.optional(v.record(v.string(), v.string()));

export const sealedSecrets = v.optional(
	v.record(v.string(), v.object({ iv: v.string(), ciphertext: v.string() })),
);

export type SealedSecrets = Record<string, { iv: string; ciphertext: string }>;

export const importArgs = <Row extends GenericValidator>(row: Row) => ({
	organizationId: v.string(),
	projectId: v.id("projects"),
	environmentIdMap: v.record(v.string(), v.id("environments")),
	rows: v.array(row),
	// Server for rows without `links` (the import dialog's server choice);
	// the panel host when absent.
	serverId: v.optional(v.id("servers")),
});

// Loads the environments of the project being exported or duplicated. Full
// exports are admin-only (loadForExport); duplicating needs project.create
// (the selected services are checked in loadDuplicateSource).
export const authorizeExport = async (
	ctx: QueryCtx,
	projectId: Id<"projects">,
	environmentIds: Id<"environments">[],
) => {
	const project = await ctx.db.get("projects", projectId);
	if (!project) throw new ConvexError("Project not found");
	await requirePermission(ctx, project.organizationId, "project", "create");
	const environments = [];
	for (const environmentId of environmentIds) {
		const environment = await ctx.db.get("environments", environmentId);
		if (environment?.projectId === projectId) environments.push(environment);
	}
	return { project, environments };
};

export const authorizeImport = async (
	ctx: QueryCtx,
	organizationId: string,
	projectId: Id<"projects">,
	rows: unknown[],
	serverId?: Id<"servers">,
) => {
	const project = await ctx.db.get("projects", projectId);
	if (!project || project.organizationId !== organizationId) {
		throw new ConvexError("Project not found");
	}
	await requireProjectPermission(ctx, project, "project", "create");
	if (rows.length > MAX_SECTION_ROWS) {
		throw new ConvexError("Too many services in the bundle");
	}
	if (serverId) await assertImportServer(ctx, organizationId, serverId);
};

// The import target must be a deploy server of the organization.
export const assertImportServer = async (
	ctx: QueryCtx,
	organizationId: string,
	serverId: Id<"servers">,
) => {
	const server = await ctx.db.get("servers", serverId);
	if (
		!server ||
		server.organizationId !== organizationId ||
		server.serverType === "build"
	) {
		throw new ConvexError("Server not found");
	}
};

// Ids of the organization's servers, registries and networks a service used.
// Only `includeLinks` exports (same-organization copies) carry them; imports
// re-check each one against the importing organization.
export const linksRow = v.optional(
	v.object({
		serverId: v.optional(v.string()),
		buildServerId: v.optional(v.string()),
		registryId: v.optional(v.string()),
		buildRegistryId: v.optional(v.string()),
		rollbackRegistryId: v.optional(v.string()),
		networkIds: v.optional(v.array(v.string())),
		detachPanaraCloudNetwork: v.optional(v.boolean()),
		serviceNetworks: v.optional(
			v.array(
				v.object({
					serviceName: v.string(),
					networkIds: v.array(v.string()),
					detachPanaraCloudNetwork: v.boolean(),
				}),
			),
		),
	}),
);

export type LinksRow = NonNullable<typeof linksRow.type>;

export type ResolvedLinks = {
	serverId?: Id<"servers">;
	buildServerId?: Id<"servers">;
	registryId?: Id<"registries">;
	buildRegistryId?: Id<"registries">;
	rollbackRegistryId?: Id<"registries">;
	networkIds?: Id<"networks">[];
	detachPanaraCloudNetwork?: boolean;
	serviceNetworks?: {
		serviceName: string;
		networkIds: Id<"networks">[];
		detachPanaraCloudNetwork: boolean;
	}[];
};

const MAX_LINKED_NETWORKS = 20;
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Turns a row's `links` (or the chosen import server) into ids that belong
// to `organizationId`; anything else is dropped with a warning.
export const resolveLinks = async (
	ctx: QueryCtx,
	input: {
		organizationId: string;
		links: LinksRow | undefined;
		serverId: Id<"servers"> | undefined;
		name: string;
	},
	warnings: string[],
): Promise<ResolvedLinks> => {
	const { organizationId, links, name } = input;
	if (!links) {
		if (input.serverId) {
			await assertImportServer(ctx, organizationId, input.serverId);
		} else {
			await assertPanelHostTarget(ctx, organizationId);
		}
		return input.serverId ? { serverId: input.serverId } : {};
	}
	const server = async (raw: string | undefined, label: string) => {
		if (!raw) return undefined;
		const id = ctx.db.normalizeId("servers", raw);
		const row = id ? await ctx.db.get("servers", id) : null;
		if (!row || row.organizationId !== organizationId) {
			warnings.push(
				`"${name}": its ${label} is not available; select it again.`,
			);
			return undefined;
		}
		return row._id;
	};
	const registry = async (raw: string | undefined) => {
		if (!raw) return undefined;
		const id = ctx.db.normalizeId("registries", raw);
		const row = id ? await ctx.db.get("registries", id) : null;
		if (!row || row.organizationId !== organizationId) {
			warnings.push(
				`"${name}": its registry is not available; select it again.`,
			);
			return undefined;
		}
		return row._id;
	};
	let serverId: Id<"servers"> | undefined;
	if (links.serverId) {
		const id = ctx.db.normalizeId("servers", links.serverId);
		const row = id ? await ctx.db.get("servers", id) : null;
		if (
			row &&
			row.organizationId === organizationId &&
			row.serverType !== "build"
		) {
			serverId = row._id;
		} else if (input.serverId) {
			await assertImportServer(ctx, organizationId, input.serverId);
			serverId = input.serverId;
			warnings.push(
				`"${name}": its server is not available; it was placed on the selected server.`,
			);
		} else {
			throw new ConvexError(
				`"${name}": its server is not available; select a server to import it into`,
			);
		}
	} else {
		await assertPanelHostTarget(ctx, organizationId);
	}
	const networks = async (raw: string[] | undefined, overlayOnly: boolean) => {
		const result: Id<"networks">[] = [];
		for (const value of (raw ?? []).slice(0, MAX_LINKED_NETWORKS)) {
			const id = ctx.db.normalizeId("networks", value);
			const row = id ? await ctx.db.get("networks", id) : null;
			if (
				!row ||
				row.organizationId !== organizationId ||
				row.serverId !== serverId ||
				(overlayOnly && row.driver !== "overlay")
			) {
				warnings.push(
					`"${name}": a network it was attached to is not available on its server; attach it again.`,
				);
				continue;
			}
			if (!result.includes(row._id)) result.push(row._id);
		}
		return result;
	};
	const registryId = await registry(links.registryId);
	const buildRegistryId = await registry(links.buildRegistryId);
	let buildServerId = await server(links.buildServerId, "build server");
	if (buildServerId && !registryId && !buildRegistryId) {
		buildServerId = undefined;
	}
	const networkIds = await networks(links.networkIds, true);
	const serviceNetworks = [];
	for (const entry of (links.serviceNetworks ?? []).slice(0, 50)) {
		if (!SERVICE_NAME.test(entry.serviceName)) continue;
		const ids = await networks(entry.networkIds, false);
		serviceNetworks.push({
			serviceName: entry.serviceName,
			networkIds: ids,
			detachPanaraCloudNetwork:
				entry.detachPanaraCloudNetwork && ids.length > 0,
		});
	}
	return {
		serverId,
		buildServerId,
		registryId,
		buildRegistryId,
		rollbackRegistryId: await registry(links.rollbackRegistryId),
		...(networkIds.length > 0 ? { networkIds } : {}),
		...(links.detachPanaraCloudNetwork && networkIds.length > 0
			? { detachPanaraCloudNetwork: true }
			: {}),
		...(serviceNetworks.length > 0 ? { serviceNetworks } : {}),
	};
};

export const exportSecrets = async (
	ctx: QueryCtx,
	ownerId: string,
	kinds: Record<string, string>,
): Promise<Record<string, string>> => {
	const result: Record<string, string> = {};
	for (const [field, kind] of Object.entries(kinds)) {
		const value = await readSecret(ctx, kind, ownerId);
		if (value) result[field] = value;
	}
	return result;
};

// Writes only the whitelisted fields; anything else in the bundle is ignored.
export const importSecrets = async (
	ctx: MutationCtx,
	organizationId: string,
	ownerId: string,
	kinds: Record<string, string>,
	sealed: SealedSecrets | undefined,
) => {
	for (const [field, value] of Object.entries(sealed ?? {})) {
		const kind = kinds[field];
		if (!kind) continue;
		await putSecret(ctx, { organizationId, kind, ownerId, ...value });
	}
};

export const mapEnvironment = (
	environmentIdMap: Record<string, Id<"environments">>,
	exported: string,
): Id<"environments"> | null =>
	environmentIdMap[exported] ?? environmentIdMap[""] ?? null;

// Exported appNames end in a random suffix; imported
// services get the same base with a fresh, instance-unique suffix.
export const appNameBase = (appName: string) =>
	appName.replace(/-[a-z0-9]{6}$/, "").slice(0, 50) || undefined;

export const uniqueAppName = async (
	ctx: QueryCtx,
	generate: () => string,
): Promise<string> => {
	for (let attempt = 0; attempt < 10; attempt++) {
		const name = generate();
		if (!(await isAppNameInUse(ctx, name))) return name;
	}
	throw new ConvexError("Could not generate a unique app name");
};

export const renameVolume = (
	volumeName: string,
	oldAppName: string,
	newAppName: string,
) =>
	volumeName.startsWith(oldAppName)
		? `${newAppName}${volumeName.slice(oldAppName.length)}`
		: volumeName;

export const mountRow = mountInput;

// File mounts often hold configuration secrets, so their content only
// travels in encrypted exports.
export const exportMounts = async (
	ctx: QueryCtx,
	owner: MountOwner,
	includeSecrets: boolean,
): Promise<{ mounts: MountInput[]; skippedFiles: number }> => {
	const mounts: MountInput[] = [];
	let skippedFiles = 0;
	for (const {
		_id,
		_creationTime,
		organizationId,
		owner: _owner,
		...mount
	} of await listMounts(ctx, owner)) {
		if (mount.type === "file" && !includeSecrets) {
			skippedFiles++;
			continue;
		}
		mounts.push(mount);
	}
	return { mounts, skippedFiles };
};

export const importMounts = async (
	ctx: MutationCtx,
	organizationId: string,
	owner: MountOwner,
	mounts: MountInput[],
	appNames: { from: string; to: string },
) => {
	for (const mount of mounts) {
		await addMount(
			ctx,
			organizationId,
			owner,
			mount.type === "volume"
				? {
						...mount,
						volumeName: renameVolume(
							mount.volumeName,
							appNames.from,
							appNames.to,
						),
					}
				: mount,
		);
	}
};

// Provider-backed sources reference a git provider of the exporting
// organization, so only plain git URLs survive an import; the rest are kept
// in the bundle to name the repository in the warning.
export const gitSourceRow = v.object({
	type: v.union(
		v.literal("github"),
		v.literal("gitlab"),
		v.literal("gitea"),
		v.literal("bitbucket"),
		v.literal("git"),
	),
	url: v.optional(v.string()),
	owner: v.optional(v.string()),
	repository: v.optional(v.string()),
	pathNamespace: v.optional(v.string()),
	repositorySlug: v.optional(v.string()),
	projectId: v.optional(v.number()),
	usedSshKey: v.optional(v.boolean()),
	// Only in `includeLinks` exports.
	gitProviderId: v.optional(v.string()),
	sshKeyId: v.optional(v.string()),
	branch: v.string(),
	buildPath: v.string(),
	submodules: v.boolean(),
	watchPaths: v.optional(v.array(v.string())),
});

export type GitSourceRow = typeof gitSourceRow.type;

export const exportGitSource = (
	source: GitSource,
	includeLinks = false,
): GitSourceRow => {
	const common = {
		branch: source.branch,
		buildPath: source.buildPath,
		submodules: source.submodules,
		watchPaths: source.watchPaths,
		...(includeLinks && source.type !== "git"
			? { gitProviderId: source.gitProviderId }
			: {}),
	};
	switch (source.type) {
		case "git":
			return {
				type: "git",
				url: source.url,
				usedSshKey: !!source.sshKeyId,
				...(includeLinks && source.sshKeyId
					? { sshKeyId: source.sshKeyId }
					: {}),
				...common,
			};
		case "gitlab":
			return {
				type: "gitlab",
				owner: source.owner,
				repository: source.repository,
				pathNamespace: source.pathNamespace,
				projectId: source.projectId,
				...common,
			};
		case "bitbucket":
			return {
				type: "bitbucket",
				owner: source.owner,
				repository: source.repository,
				repositorySlug: source.repositorySlug,
				...common,
			};
		default:
			return {
				type: source.type,
				owner: source.owner,
				repository: source.repository,
				...common,
			};
	}
};

const providerSource = async (
	ctx: QueryCtx,
	organizationId: string,
	row: GitSourceRow,
): Promise<GitSource | null> => {
	const gitProviderId = row.gitProviderId
		? ctx.db.normalizeId("gitProviders", row.gitProviderId)
		: null;
	if (!gitProviderId || !row.owner || !row.repository) return null;
	const common = {
		gitProviderId,
		owner: row.owner,
		repository: row.repository,
		branch: row.branch,
		buildPath: row.buildPath,
		submodules: row.submodules,
		watchPaths: row.watchPaths,
	};
	const source: GitSource | null =
		row.type === "github" || row.type === "gitea"
			? { type: row.type, ...common }
			: row.type === "gitlab" && row.pathNamespace
				? {
						type: "gitlab",
						...common,
						pathNamespace: row.pathNamespace,
						projectId: row.projectId,
					}
				: row.type === "bitbucket"
					? {
							type: "bitbucket",
							...common,
							repositorySlug: row.repositorySlug,
						}
					: null;
	if (!source) return null;
	try {
		await assertGitSourceInOrganization(ctx, organizationId, source);
		return source;
	} catch {
		return null;
	}
};

const sshKeyOf = async (
	ctx: QueryCtx,
	organizationId: string,
	raw: string | undefined,
) => {
	const id = raw ? ctx.db.normalizeId("sshKeys", raw) : null;
	const key = id ? await ctx.db.get("sshKeys", id) : null;
	return key?.organizationId === organizationId ? key._id : undefined;
};

export const importGitSource = async (
	ctx: QueryCtx,
	organizationId: string,
	row: GitSourceRow,
	name: string,
	warnings: string[],
): Promise<GitSource | null> => {
	if (row.type !== "git" || !row.url) {
		const linked = await providerSource(ctx, organizationId, row);
		if (linked) return linked;
		warnings.push(
			`"${name}" used the ${row.type} repository ${row.owner ?? ""}/${row.repository ?? ""}; reconnect it after importing.`,
		);
		return null;
	}
	const sshKeyId = await sshKeyOf(ctx, organizationId, row.sshKeyId);
	const source: GitSource = {
		type: "git",
		url: row.url,
		...(sshKeyId ? { sshKeyId } : {}),
		branch: row.branch,
		buildPath: row.buildPath,
		submodules: row.submodules,
		watchPaths: row.watchPaths,
	};
	await assertGitSourceInOrganization(ctx, organizationId, source);
	if (row.usedSshKey && !sshKeyId) {
		warnings.push(
			`"${name}" used an SSH key; select it again after importing.`,
		);
	}
	return source;
};
