import { ConvexError, type Infer, v } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { serviceIdByAppName } from "./appNames";
import {
	assertBindMountAllowed,
	isReservedName,
	isTrustedRequester,
} from "./hostPolicy";
import { canAccessService, resolvePermissions } from "./permissions";

// Mounts belong to a service owned by another domain (application, compose,
// postgres, ...). Domains expose their own public functions, authorize against
// the owning service, then call these helpers.
export const mountOwner = v.object({ kind: v.string(), id: v.string() });

export const mountInput = v.union(
	v.object({
		type: v.literal("bind"),
		hostPath: v.string(),
		mountPath: v.string(),
	}),
	v.object({
		type: v.literal("volume"),
		volumeName: v.string(),
		mountPath: v.string(),
	}),
	v.object({
		type: v.literal("file"),
		filePath: v.string(),
		content: v.string(),
		mountPath: v.string(),
	}),
);

export type MountOwner = Infer<typeof mountOwner>;
export type MountInput = Infer<typeof mountInput>;

const MAX_MOUNTS = 100;
const MAX_FILE_CONTENT = 512 * 1024;

const validate = (owner: MountOwner, mount: MountInput) => {
	// Compose file mounts are files next to the compose file, referenced from
	// the compose definition itself, so they have no container mount path.
	const pathOptional = mount.type === "file" && owner.kind === "compose";
	if (
		!(pathOptional && mount.mountPath === "") &&
		!mount.mountPath.startsWith("/")
	) {
		throw new ConvexError("Mount path must be absolute");
	}
	if (mount.type === "bind" && !mount.hostPath.startsWith("/")) {
		throw new ConvexError("Host path must be absolute");
	}
	if (
		mount.type === "volume" &&
		!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(mount.volumeName)
	) {
		throw new ConvexError("Invalid volume name");
	}
	if (mount.type === "file") {
		const segments = mount.filePath.split("/");
		if (
			!mount.filePath ||
			mount.filePath.startsWith("/") ||
			segments.includes("..")
		) {
			throw new ConvexError(
				"File path must be relative and stay inside the service",
			);
		}
		if (mount.content.length > MAX_FILE_CONTENT) {
			throw new ConvexError("File content is too large");
		}
	}
};

const ownerHost = async (
	ctx: QueryCtx,
	owner: MountOwner,
): Promise<{ serverId: string | undefined }> => {
	const row =
		owner.kind === "application"
			? await getById(ctx, "applications", owner.id)
			: owner.kind === "compose"
				? await getById(ctx, "compose", owner.id)
				: owner.kind === "database"
					? await getById(ctx, "databases", owner.id)
					: null;
	if (!row) throw new ConvexError("Mount owner not found");
	return { serverId: row.serverId };
};

const getById = async (
	ctx: QueryCtx,
	table: "applications" | "compose" | "databases",
	id: string,
) => {
	const normalized = ctx.db.normalizeId(table, id);
	return normalized ? await ctx.db.get(table, normalized) : null;
};

// The services a volume name belongs to besides `owner`: those mounting it
// already, a database's data volume (<appName>-data) and compose project
// volumes (<appName>_<key>).
const volumeOwners = async (
	ctx: QueryCtx,
	organizationId: string,
	owner: MountOwner,
	volumeName: string,
): Promise<Set<string>> => {
	const owners = new Set<string>();
	const rows = await ctx.db
		.query("mounts")
		.withIndex("by_organizationId_and_volumeName", (q) =>
			q.eq("organizationId", organizationId).eq("volumeName", volumeName),
		)
		.take(MAX_MOUNTS);
	for (const row of rows) owners.add(row.owner.id);
	const candidates = volumeName.endsWith("-data")
		? [volumeName.slice(0, -"-data".length)]
		: [];
	for (
		let i = volumeName.indexOf("_");
		i > 0;
		i = volumeName.indexOf("_", i + 1)
	) {
		candidates.push(volumeName.slice(0, i));
	}
	for (const appName of candidates) {
		const serviceId = await serviceIdByAppName(ctx, organizationId, appName);
		if (serviceId) owners.add(serviceId);
	}
	owners.delete(owner.id);
	return owners;
};

// A scoped member mounts only volumes of services they can reach: another
// service's data volume would hand them its data.
const assertVolumeReachable = async (
	ctx: QueryCtx,
	organizationId: string,
	owner: MountOwner,
	volumeName: string,
) => {
	const access = await resolvePermissions(ctx, organizationId);
	if (!access.scope) return;
	for (const serviceId of await volumeOwners(
		ctx,
		organizationId,
		owner,
		volumeName,
	)) {
		if (!canAccessService(access, serviceId)) {
			throw new ConvexError(
				`${volumeName} belongs to a service you don't have access to: choose another volume name`,
			);
		}
	}
};

// Volume and bind mounts reach outside the service: reserved Panara Cloud
// volumes and host paths need the instance administrator.
const authorize = async (
	ctx: QueryCtx,
	organizationId: string,
	owner: MountOwner,
	mount: MountInput,
) => {
	if (mount.type === "volume" && isReservedName(mount.volumeName)) {
		if (!(await isTrustedRequester(ctx, organizationId))) {
			throw new ConvexError(
				`${mount.volumeName} is reserved for Panara Cloud: choose another volume name`,
			);
		}
	}
	if (mount.type === "volume") {
		await assertVolumeReachable(ctx, organizationId, owner, mount.volumeName);
	}
	if (mount.type === "bind") {
		const { serverId } = await ownerHost(ctx, owner);
		await assertBindMountAllowed(ctx, organizationId, serverId, mount.hostPath);
	}
};

export const listMounts = (ctx: QueryCtx, owner: MountOwner) =>
	ctx.db
		.query("mounts")
		.withIndex("by_owner", (q) =>
			q.eq("owner.kind", owner.kind).eq("owner.id", owner.id),
		)
		.take(MAX_MOUNTS);

export const addMount = async (
	ctx: MutationCtx,
	organizationId: string,
	owner: MountOwner,
	mount: MountInput,
) => {
	validate(owner, mount);
	await authorize(ctx, organizationId, owner, mount);
	const existing = await listMounts(ctx, owner);
	if (existing.length >= MAX_MOUNTS) throw new ConvexError("Too many mounts");
	if (
		mount.mountPath &&
		existing.some((m) => m.mountPath === mount.mountPath)
	) {
		throw new ConvexError(`${mount.mountPath} is already mounted`);
	}
	return await ctx.db.insert("mounts", { organizationId, owner, ...mount });
};

export const updateMount = async (
	ctx: MutationCtx,
	mountId: import("../_generated/dataModel").Id<"mounts">,
	mount: MountInput,
) => {
	const current = await ctx.db.get("mounts", mountId);
	if (!current) throw new ConvexError("Mount not found");
	validate(current.owner, mount);
	await authorize(ctx, current.organizationId, current.owner, mount);
	await ctx.db.replace("mounts", mountId, {
		organizationId: current.organizationId,
		owner: current.owner,
		...mount,
	});
};

export const removeMountsForOwner = async (
	ctx: MutationCtx,
	owner: MountOwner,
) => {
	for (const mount of await listMounts(ctx, owner)) {
		await ctx.db.delete("mounts", mount._id);
	}
};
