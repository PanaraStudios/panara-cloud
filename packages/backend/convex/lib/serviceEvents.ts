import type { MutationCtx } from "../_generated/server";
import type {
	ServiceEventDetails,
	ServiceEventType,
	ServiceTarget,
	StagedReapply,
} from "../tables/serviceEvents";
import { optionalCaller } from "./access";
import { decryptSecret } from "./crypto";
import { readSecret } from "./secrets";
import { resourceSettings, swarmSettings } from "./serviceSettings";

export type ServiceEventKind = ServiceTarget["kind"];

// Changes the agent only applies when it (re)creates the service from the
// stored config on the next deploy. Domains are Traefik files for
// applications and databases (applied at once) but container labels for
// compose, so they wait for a compose deploy.
const STAGED_TYPES: ReadonlySet<ServiceEventType> = new Set([
	"config.env",
	"config.ports",
	"config.mounts",
	"config.resources",
	"config.build",
	"config.source",
	"config.composeFile",
	"config.patches",
	"config.advanced",
	"config.networks",
	"config.server",
]);

export const appliesOnDeploy = (
	kind: ServiceEventKind,
	type: ServiceEventType,
): boolean =>
	STAGED_TYPES.has(type) || (type === "config.domains" && kind === "compose");

// What the agent's reload reads to
// rebuild the Swarm service with the existing image.
const APPLICATION_SPEC_TYPES: ReadonlySet<ServiceEventType> = new Set([
	"config.env",
	"config.ports",
	"config.mounts",
	"config.resources",
	"config.advanced",
	"config.networks",
]);

// The lightest job that applies a staged change (see `stagedReapply`).
// Applications: patches and git/zip sources need a fresh checkout, a server
// change a deploy there. Compose redeploys reuse the checked-out repository
// but read everything else again. Databases only apply on deploy/rebuild.
export const reapplyOf = (
	kind: ServiceEventKind,
	type: ServiceEventType,
): StagedReapply | undefined => {
	if (!appliesOnDeploy(kind, type)) return undefined;
	if (kind === "application") {
		if (APPLICATION_SPEC_TYPES.has(type)) return "spec";
		return type === "config.build" ? "build" : undefined;
	}
	if (kind === "compose") {
		return type === "config.source" || type === "config.server"
			? undefined
			: "build";
	}
	return undefined;
};

// Overrides for one event. `reapply: null` forces "only a deploy applies it".
type Staging = { appliesOnDeploy?: boolean; reapply?: StagedReapply | null };

const SUMMARIES: Record<ServiceEventType, string> = {
	"config.env": "Environment variables changed",
	"config.domains": "Domains changed",
	"config.ports": "Ports changed",
	"config.mounts": "Volumes and mounts changed",
	"config.redirects": "Redirects changed",
	"config.security": "Basic auth changed",
	"config.resources": "Resource limits changed",
	"config.build": "Build settings changed",
	"config.source": "Source changed",
	"config.composeFile": "Compose file changed",
	"config.patches": "Patches changed",
	"config.advanced": "Advanced settings changed",
	"config.networks": "Networks changed",
	"config.server": "Server changed",
	"config.externalPort": "External port changed",
	"config.rename": "Renamed",
	"config.general": "Settings changed",
	"config.previews": "Preview deployment settings changed",
	"config.rollbacks": "Rollback settings changed",
	"config.webhook": "Deploy webhook token regenerated",
	"config.traefik": "Traefik configuration edited",
	"config.schedules": "Schedules changed",
	"config.backups": "Backups changed",
	"config.volumeBackups": "Volume backups changed",
	"config.password": "Database password changed",
	"config.moved": "Moved to another environment",
	"lifecycle.created": "Service created",
	"lifecycle.start": "Start requested",
	"lifecycle.stop": "Stop requested",
	"lifecycle.restart": "Restart requested",
	"lifecycle.reload": "Reload requested",
	"lifecycle.transfer": "Transfer to another server requested",
	"runtime.crashed": "Container crashed",
	"runtime.oomKilled": "Container killed: out of memory",
	"runtime.unhealthy": "Health check failing",
};

const ACTION_VERBS = { create: "added", update: "updated", remove: "removed" };

const MAX_SUMMARY = 300;
const MAX_LIST = 50;

const clip = (list: string[] | undefined) =>
	list && list.length > 0 ? list.slice(0, MAX_LIST) : undefined;

export const describeEvent = (
	type: ServiceEventType,
	details?: ServiceEventDetails,
): string => {
	if (type === "config.rename" && details?.from && details.to) {
		return `Renamed from ${details.from} to ${details.to}`;
	}
	const times =
		details?.count && details.count > 1 ? ` (${details.count} times)` : "";
	if (type === "runtime.crashed" && details?.exitCode !== undefined) {
		return `Container exited with code ${details.exitCode}${times}`;
	}
	const base = SUMMARIES[type];
	if (type.startsWith("runtime.")) return `${base}${times}`;
	const what =
		details?.name ??
		details?.host ??
		details?.path ??
		details?.port?.toString();
	if (details?.action && what) {
		return `${base.replace(/ changed$/, "")}: ${what} ${ACTION_VERBS[details.action]}`;
	}
	if (type === "config.env" && details) {
		const parts = [
			details.added?.length && `added ${details.added.join(", ")}`,
			details.removed?.length && `removed ${details.removed.join(", ")}`,
			details.changed?.length && `changed ${details.changed.join(", ")}`,
		].filter(Boolean);
		if (parts.length > 0) return `Environment variables: ${parts.join("; ")}`;
	}
	return base;
};

// One call per mutation that changes a service's config or lifecycle.
// `actorId` is the signed-in user; leave it undefined for webhooks and the
// system. `details` must never carry secret values.
export const recordServiceEvent = async (
	ctx: MutationCtx,
	kind: ServiceEventKind,
	service: { _id: string; organizationId: string },
	type: ServiceEventType,
	actorId: string | undefined,
	details?: ServiceEventDetails & Staging,
) => {
	const {
		appliesOnDeploy: stagedOverride,
		reapply: reapplyOverride,
		...rest
	} = details ?? {};
	const staged = stagedOverride ?? appliesOnDeploy(kind, type);
	const reapply =
		reapplyOverride === undefined
			? reapplyOf(kind, type)
			: (reapplyOverride ?? undefined);
	const cleaned: ServiceEventDetails = {
		...rest,
		fields: clip(rest.fields),
		added: clip(rest.added),
		removed: clip(rest.removed),
		changed: clip(rest.changed),
	};
	const hasDetails = Object.values(cleaned).some((v) => v !== undefined);
	// A compose service's configuration is only as trusted as its last
	// author: record who that was (see composeJobTrusted).
	if (
		kind === "compose" &&
		actorId !== undefined &&
		(type.startsWith("config.") || type === "lifecycle.created")
	) {
		const id = ctx.db.normalizeId("compose", service._id);
		if (id) await ctx.db.patch("compose", id, { configuredBy: actorId });
	}
	await ctx.db.insert("serviceEvents", {
		organizationId: service.organizationId,
		target: { kind, id: service._id },
		type,
		actorId,
		summary: describeEvent(type, cleaned).slice(0, MAX_SUMMARY),
		details: hasDetails ? cleaned : undefined,
		appliesOnDeploy: staged,
		reapply: staged ? reapply : undefined,
	});
};

// The fields a patch actually sets, for `details.fields`.
export const changedFields = (patch: Record<string, unknown>): string[] =>
	Object.entries(patch)
		.filter(([, value]) => value !== undefined)
		.map(([key]) => key);

// Mirrors the agent's parseEnv (apps/agent/src/lib/env.ts) closely enough to
// name the variables; values are compared here and never stored.
export const parseEnvValues = (text: string): Map<string, string> => {
	const result = new Map<string, string>();
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(
			line,
		);
		if (match) result.set(match[1] as string, match[2] ?? "");
	}
	return result;
};

export const diffEnvNames = (before: string, after: string) => {
	const old = parseEnvValues(before);
	const next = parseEnvValues(after);
	const added: string[] = [];
	const changed: string[] = [];
	for (const [key, value] of next) {
		if (!old.has(key)) added.push(key);
		else if (old.get(key) !== value) changed.push(key);
	}
	const removed = [...old.keys()].filter((key) => !next.has(key));
	return { added, removed, changed };
};

type Encrypted = { iv: string; ciphertext: string };

// How a saved variable set takes effect: like a staged event's `reapply`,
// "deploy" when only a deploy applies it, "never" when no deploy of the
// service reads it (preview-only variables).
export type EnvApplies = StagedReapply | "deploy" | "never";

const ENV_WEIGHT: Record<EnvApplies, number> = {
	never: 0,
	spec: 1,
	build: 2,
	deploy: 3,
};

type EnvGroup = {
	labels: string[];
	added: Set<string>;
	removed: Set<string>;
	changed: Set<string>;
};

const recordEnvGroup = (
	ctx: MutationCtx,
	kind: ServiceEventKind,
	service: { _id: string; organizationId: string },
	actorId: string | undefined,
	applies: EnvApplies,
	group: EnvGroup,
) =>
	recordServiceEvent(ctx, kind, service, "config.env", actorId, {
		fields: group.labels,
		added: [...group.added],
		removed: [...group.removed],
		changed: [...group.changed],
		appliesOnDeploy: applies !== "never",
		reapply: applies === "spec" || applies === "build" ? applies : null,
	});

// One event per way the changed variables take effect, so a reload can
// apply runtime env while build args stay pending. Call before the secrets
// are overwritten. `applies` defaults to how `config.env` is staged for the
// service kind.
export const recordEnvEvent = async (
	ctx: MutationCtx,
	kind: ServiceEventKind,
	service: { _id: string; organizationId: string },
	actorId: string | undefined,
	changes: {
		kind: string;
		label: string;
		next: Encrypted | null;
		applies?: EnvApplies;
	}[],
) => {
	const groups = new Map<EnvApplies, EnvGroup>();
	for (const change of changes) {
		const applies = change.applies ?? reapplyOf(kind, "config.env") ?? "deploy";
		let group = groups.get(applies);
		if (!group) {
			group = {
				labels: [],
				added: new Set(),
				removed: new Set(),
				changed: new Set(),
			};
			groups.set(applies, group);
		}
		group.labels.push(change.label);
		const before = (await readSecret(ctx, change.kind, service._id)) ?? "";
		const after = change.next ? await decryptSecret(change.next) : "";
		const diff = diffEnvNames(before, after);
		for (const key of diff.added) group.added.add(key);
		for (const key of diff.removed) group.removed.add(key);
		for (const key of diff.changed) group.changed.add(key);
	}
	const changed = [...groups].filter(
		([, group]) => group.added.size + group.removed.size + group.changed.size,
	);
	if (changed.length > 0) {
		for (const [applies, group] of changed) {
			await recordEnvGroup(ctx, kind, service, actorId, applies, group);
		}
		return;
	}
	// No variable name or value changed that we can tell (e.g. only comments):
	// one event for the whole save, applied by the heaviest job any of it needs.
	let heaviest: EnvApplies = "never";
	for (const applies of groups.keys()) {
		if (ENV_WEIGHT[applies] > ENV_WEIGHT[heaviest]) heaviest = applies;
	}
	await recordEnvGroup(ctx, kind, service, actorId, heaviest, {
		labels: [...groups.values()].flatMap((group) => group.labels),
		added: new Set(),
		removed: new Set(),
		changed: new Set(),
	});
};

const RESOURCE_KEYS: ReadonlySet<string> = new Set(
	Object.keys(resourceSettings),
);
const ADVANCED_KEYS: ReadonlySet<string> = new Set([
	...Object.keys(swarmSettings),
	"command",
	"args",
	"replicas",
]);
const BUILD_KEYS: ReadonlySet<string> = new Set(["cleanCache", "build"]);

// Splits one settings patch into an event per area (rename, resources,
// advanced/swarm, build, general). `keys` lists every field the patch sets or
// clears; `areas` maps service-specific keys to an area.
export const recordSettingsEvents = async (
	ctx: MutationCtx,
	kind: ServiceEventKind,
	service: { _id: string; organizationId: string; name?: string },
	actorId: string | undefined,
	keys: string[],
	options: {
		newName?: string;
		areas?: Partial<Record<string, ServiceEventType>>;
	} = {},
) => {
	const groups = new Map<ServiceEventType, string[]>();
	for (const key of keys) {
		const type: ServiceEventType =
			options.areas?.[key] ??
			(key === "name"
				? "config.rename"
				: RESOURCE_KEYS.has(key)
					? "config.resources"
					: ADVANCED_KEYS.has(key)
						? "config.advanced"
						: BUILD_KEYS.has(key)
							? "config.build"
							: "config.general");
		groups.set(type, [...(groups.get(type) ?? []), key]);
	}
	for (const [type, fields] of groups) {
		if (type === "config.rename") {
			if (options.newName === undefined || options.newName === service.name) {
				continue;
			}
			await recordServiceEvent(ctx, kind, service, type, actorId, {
				from: service.name,
				to: options.newName,
			});
			continue;
		}
		await recordServiceEvent(ctx, kind, service, type, actorId, { fields });
	}
};

const SERVICE_KINDS: ReadonlySet<string> = new Set([
	"application",
	"compose",
	"database",
]);

// For rows owned by `{ kind, id }` (mounts, domains, ports, redirects, basic
// auth, schedules, backups). Owners that aren't services, such as previews,
// servers or the panel, have no trail.
export const recordOwnerEvent = async (
	ctx: MutationCtx,
	owner: { kind: string; id: string },
	organizationId: string,
	type: ServiceEventType,
	actorId: string | undefined,
	details?: ServiceEventDetails & Staging,
) => {
	if (!SERVICE_KINDS.has(owner.kind)) return;
	await recordServiceEvent(
		ctx,
		owner.kind as ServiceEventKind,
		{ _id: owner.id, organizationId },
		type,
		actorId,
		details,
	);
};

// The signed-in user, for sites whose permission helper doesn't return it.
export const actorOf = async (ctx: MutationCtx): Promise<string | undefined> =>
	(await optionalCaller(ctx))?.userId;

export const mountDetails = (
	mount: { mountPath: string; filePath?: string },
	action: "create" | "update" | "remove",
): ServiceEventDetails => ({
	path: mount.mountPath || mount.filePath || undefined,
	action,
});
