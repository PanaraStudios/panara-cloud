import { parse } from "yaml";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isReservedName } from "./hostPolicy";
import { listMounts, type MountOwner } from "./mounts";
import { type Access, canAccessService } from "./permissions";

export type VolumeUserKind = "application" | "compose" | "database";

export type VolumeUser = {
	kind: VolumeUserKind;
	id: string;
	organizationId: string;
	name: string;
	appName: string;
};

type ComposeNaming = Pick<
	Doc<"compose">,
	| "appName"
	| "randomize"
	| "suffix"
	| "isolatedDeployment"
	| "isolatedDeploymentsVolume"
>;

const MAX_MOUNT_ROWS = 100;
const MAX_DELETED_TOGETHER = 200;

// The `deletingTogether` argument of the remove mutations, as stored in the
// job: a hint only (see tables/core.ts), so it is bounded, never trusted.
export const boundedAppNames = (appNames: string[] | undefined): string[] =>
	[...new Set(appNames ?? [])]
		.filter((appName) => appName.length > 0 && appName.length <= 200)
		.slice(0, MAX_DELETED_TOGETHER);
// Compose files are read in full, so the scan of one server is bounded; past
// it the answer is marked incomplete and the caller keeps the volumes.
const MAX_COMPOSE_SCANNED = 200;
export const TOO_MANY_COMPOSE_SERVICES =
	"this server has too many Compose services to check what else uses it";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// A deploy renames the keys of the file's volumes (`randomize`, or an
// isolated deployment with its own volumes); both spellings are answered, so
// a volume created before the setting changed is still recognised.
const keySpellings = (key: string, compose: ComposeNaming): string[] => {
	const spellings = [key];
	if (compose.isolatedDeployment) {
		if (compose.isolatedDeploymentsVolume) {
			spellings.push(`${key}-${compose.appName}`);
		}
	} else if (compose.randomize && compose.suffix) {
		spellings.push(`${key}-${compose.suffix}`);
	}
	return spellings;
};

// The Docker volume names a compose file's top-level `volumes` stand for:
// `created` are the project's own (<appName>_<key>, or an explicit `name:`),
// `referenced` adds the external ones, which belong to something else. Names
// built from variables (`${VOLUME}`) can't be resolved here and are skipped.
export const composeVolumeNames = (
	content: string,
	compose: ComposeNaming,
): { created: string[]; referenced: string[] } => {
	const created = new Set<string>();
	const referenced = new Set<string>();
	let volumes: unknown;
	try {
		volumes = (parse(content) as { volumes?: unknown } | null)?.volumes;
	} catch {
		return { created: [], referenced: [] };
	}
	if (!isRecord(volumes)) return { created: [], referenced: [] };
	for (const [key, value] of Object.entries(volumes)) {
		const definition = isRecord(value) ? value : {};
		const external =
			definition.external === true || isRecord(definition.external);
		const externalName = isRecord(definition.external)
			? definition.external.name
			: undefined;
		const explicit =
			typeof definition.name === "string"
				? definition.name
				: typeof externalName === "string"
					? externalName
					: undefined;
		const names = explicit
			? [explicit]
			: keySpellings(key, compose).map((spelling) =>
					external ? spelling : `${compose.appName}_${spelling}`,
				);
		for (const name of names) {
			if (name.includes("$")) continue;
			referenced.add(name);
			if (!external) created.add(name);
		}
	}
	return { created: [...created], referenced: [...referenced] };
};

const TABLES = {
	application: "applications",
	compose: "compose",
	database: "databases",
} as const;

const loadService = async (
	ctx: QueryCtx,
	owner: MountOwner,
): Promise<
	| (Doc<"applications" | "compose" | "databases"> & { kind: VolumeUserKind })
	| null
> => {
	if (!(owner.kind in TABLES)) return null;
	const kind = owner.kind as VolumeUserKind;
	const id = ctx.db.normalizeId(TABLES[kind], owner.id);
	const row = id ? await ctx.db.get(TABLES[kind], id) : null;
	return row ? { ...row, kind } : null;
};

const sameServer = (
	a: Id<"servers"> | undefined,
	b: Id<"servers"> | undefined,
) => (a ?? null) === (b ?? null);

// The services defined in the panel on one server, of any organization, whose
// definition names each volume: an application, database or compose volume
// mount, or a compose file (stored in the panel) declaring it as external or
// under the same explicit `name:`. Deployed or not. `complete` is false when
// the server has more compose services than are scanned.
export const volumeUsers = async (
	ctx: QueryCtx,
	serverId: Id<"servers"> | undefined,
	volumeNames: readonly string[],
): Promise<{ users: Map<string, VolumeUser[]>; complete: boolean }> => {
	const users = new Map<string, VolumeUser[]>();
	const add = (
		volumeName: string,
		row: Doc<"applications" | "compose" | "databases">,
		kind: VolumeUserKind,
	) => {
		const list = users.get(volumeName) ?? [];
		if (!list.some((user) => user.id === row._id)) {
			list.push({
				kind,
				id: row._id,
				organizationId: row.organizationId,
				name: row.name,
				appName: row.appName,
			});
		}
		users.set(volumeName, list);
	};
	const wanted = new Set(volumeNames);
	if (wanted.size === 0) return { users, complete: true };

	for (const volumeName of wanted) {
		const mounts = await ctx.db
			.query("mounts")
			.withIndex("by_volumeName", (q) => q.eq("volumeName", volumeName))
			.take(MAX_MOUNT_ROWS);
		for (const mount of mounts) {
			const service = await loadService(ctx, mount.owner);
			if (service && sameServer(service.serverId, serverId)) {
				add(volumeName, service, service.kind);
			}
		}
	}

	const composes = await ctx.db
		.query("compose")
		.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
		.take(MAX_COMPOSE_SCANNED + 1);
	for (const compose of composes.slice(0, MAX_COMPOSE_SCANNED)) {
		if (compose.sourceType !== "raw") continue;
		const file = await ctx.db
			.query("composeFiles")
			.withIndex("by_composeId", (q) => q.eq("composeId", compose._id))
			.unique();
		if (!file) continue;
		for (const name of composeVolumeNames(file.content, compose).referenced) {
			if (wanted.has(name)) add(name, compose, "compose");
		}
	}
	return { users, complete: composes.length <= MAX_COMPOSE_SCANNED };
};

// The named volumes that are a service's own, the ones "Also delete volumes"
// is about: what an application or database mounts, and what a compose file
// stored in the panel creates. Null for a compose service read from Git: its
// file is only on its server. Panara Cloud's own volumes are never listed.
export const ownVolumeNames = async (
	ctx: QueryCtx,
	owner: MountOwner,
): Promise<string[] | null> => {
	const names = new Set<string>();
	for (const mount of await listMounts(ctx, owner)) {
		if (mount.type === "volume") names.add(mount.volumeName);
	}
	if (owner.kind === "compose") {
		const id = ctx.db.normalizeId("compose", owner.id);
		const compose = id ? await ctx.db.get("compose", id) : null;
		if (compose?.sourceType !== "raw") return null;
		const file = await ctx.db
			.query("composeFiles")
			.withIndex("by_composeId", (q) => q.eq("composeId", compose._id))
			.unique();
		for (const name of composeVolumeNames(file?.content ?? "", compose)
			.created) {
			names.add(name);
		}
	}
	return [...names].filter((name) => !isReservedName(name));
};

const KIND_LABEL: Record<VolumeUserKind, string> = {
	application: "application",
	compose: "Compose service",
	database: "database",
};

// How a volume's user is named to someone: "Blog (Compose service)", or
// without its name when they may not see that service.
export const volumeUserLabel = (user: VolumeUser, named: boolean): string =>
	named ? `${user.name} (${KIND_LABEL[user.kind]})` : "another service";

export const usedByReason = (labels: readonly string[]): string => {
	const unique = [...new Set(labels)];
	const listed = unique.slice(0, 3);
	if (unique.length > listed.length) {
		listed.push(`${unique.length - listed.length} more`);
	}
	return `still used by ${new Intl.ListFormat("en", { type: "conjunction" }).format(listed)}`;
};

// What a removal of an application or database with "Also delete volumes" is
// queued with. `volumeNames` are the service's own volumes that no other
// service defined on its server names; the job still looks at containers and
// asks again before it removes one. The ones another service names stay out
// of the job altogether (so an agent that predates these checks cannot remove
// them either) and are only reported: `keptVolumes`. A service deleted in the
// same action (`deletingTogether`, honoured for services the caller may
// delete) does not keep a volume: the job waits for it instead.
export const volumesToRemove = async (
	ctx: QueryCtx,
	service: {
		_id: string;
		organizationId: string;
		serverId?: Id<"servers">;
	},
	owner: MountOwner,
	options: { deletingTogether: readonly string[]; access: Access },
): Promise<{
	volumeNames: string[];
	keptVolumes: { name: string; reason: string }[];
}> => {
	const own = (await ownVolumeNames(ctx, owner)) ?? [];
	const { users } = await volumeUsers(ctx, service.serverId, own);
	const together = new Set(options.deletingTogether);
	const visible = (user: VolumeUser) =>
		user.organizationId === service.organizationId &&
		canAccessService(options.access, user.id);
	const volumeNames: string[] = [];
	const keptVolumes: { name: string; reason: string }[] = [];
	for (const name of own) {
		const others = (users.get(name) ?? []).filter(
			(user) =>
				user.id !== service._id &&
				!(together.has(user.appName) && visible(user)),
		);
		if (others.length === 0) {
			volumeNames.push(name);
		} else {
			keptVolumes.push({
				name,
				reason: usedByReason(
					others.map((user) => volumeUserLabel(user, visible(user))),
				),
			});
		}
	}
	return { volumeNames, keptVolumes };
};
