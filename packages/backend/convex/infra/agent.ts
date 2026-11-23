import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import {
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "../_generated/server";
import { requireAgent } from "../lib/agentAuth";
import { decryptSecret } from "../lib/crypto";
import { requireLease } from "../lib/lease";
import {
	TOO_MANY_COMPOSE_SERVICES,
	volumeUserLabel,
	volumeUsers,
} from "../lib/volumeRefs";
import { LOCAL_PARTITION } from "../tables/core";
import { snapshotKind } from "../tables/infra";
import { CERTIFICATE_KEY_SECRET } from "./certificates";
import { loadRoutingSnapshot } from "./routing";
import { isIp } from "./validation";
import {
	DEFAULT_WEB_SERVER_SETTINGS,
	loadTraefikSettings,
	loadWebServerSettings,
	TRAEFIK_ENV_SECRET,
} from "./webServer";

const MAX_PAYLOAD_CHARS = 900_000;

const lease = { jobId: v.id("jobs"), leaseId: v.string() };

type JobSpec = Doc<"jobs">["spec"];

const requireSpec = async <K extends JobSpec["kind"]>(
	ctx: QueryCtx,
	args: { jobId: Doc<"jobs">["_id"]; leaseId: string },
	kinds: readonly K[],
) => {
	const { job } = await requireLease(ctx, args.jobId, args.leaseId);
	if (!(kinds as readonly string[]).includes(job.spec.kind)) {
		throw new ConvexError(`Not available for ${job.spec.kind} jobs`);
	}
	return { job, spec: job.spec as Extract<JobSpec, { kind: K }> };
};

const serverIdOf = (job: Doc<"jobs">) =>
	job.partition === LOCAL_PARTITION
		? undefined
		: (job.partition as Doc<"servers">["_id"]);

export const getSetupContext = query({
	args: lease,
	handler: async (ctx, args) => {
		const { spec } = await requireSpec(ctx, args, ["infra.serverSetup"]);
		const server = spec.serverId
			? await ctx.db.get("servers", spec.serverId)
			: null;
		if (spec.serverId && !server) throw new ConvexError("Server not found");
		const settings = await loadWebServerSettings(ctx);
		const address = server ? server.ipAddress : settings?.serverIp;
		const custom = server
			? await ctx.db
					.query("serverSetupScripts")
					.withIndex("by_serverId", (q) => q.eq("serverId", server._id))
					.unique()
			: null;
		return {
			isLocal: !server,
			name: server?.name ?? "panel",
			serverType: server?.serverType ?? ("deploy" as const),
			advertiseAddr: address && isIp(address) ? address : null,
			customScript: custom?.script ?? null,
		};
	},
});

export const getSetupScriptContext = query({
	args: lease,
	handler: async (ctx, args) => {
		const { job } = await requireSpec(ctx, args, ["infra.setupScript"]);
		const serverId = serverIdOf(job);
		const server = serverId ? await ctx.db.get("servers", serverId) : null;
		if (serverId && !server) throw new ConvexError("Server not found");
		const settings = await loadWebServerSettings(ctx);
		const address = server ? server.ipAddress : settings?.serverIp;
		return {
			serverType: server?.serverType ?? ("deploy" as const),
			advertiseAddr: address && isIp(address) ? address : null,
		};
	},
});

export const reportPublicIp = mutation({
	args: { ...lease, ip: v.union(v.string(), v.null()) },
	handler: async (ctx, args) => {
		await requireSpec(ctx, args, ["infra.publicIp"]);
		const ip = args.ip?.trim() || null;
		if (ip !== null && !isIp(ip)) throw new ConvexError("Invalid IP address");
		const fields = {
			publicIp: ip ?? undefined,
			publicIpCheckedAt: Date.now(),
		};
		const settings = await loadWebServerSettings(ctx);
		if (settings) {
			await ctx.db.patch("webServerSettings", settings._id, fields);
		} else {
			await ctx.db.insert("webServerSettings", {
				...DEFAULT_WEB_SERVER_SETTINGS,
				...fields,
			});
		}
	},
});

export const getRoutingSnapshot = query({
	args: lease,
	handler: async (ctx, args) => {
		const { spec } = await requireSpec(ctx, args, ["infra.routingSync"]);
		return await loadRoutingSnapshot(ctx, spec.owner);
	},
});

export const getCertificate = query({
	args: lease,
	handler: async (ctx, args) => {
		const { spec } = await requireSpec(ctx, args, ["infra.certificateSync"]);
		const certificate = await ctx.db.get("certificates", spec.certificateId);
		if (!certificate) return null;
		const chain = await ctx.db
			.query("certificateChains")
			.withIndex("by_certificateId", (q) =>
				q.eq("certificateId", certificate._id),
			)
			.unique();
		const secret = await ctx.db
			.query("secrets")
			.withIndex("by_kind_and_ownerId", (q) =>
				q.eq("kind", CERTIFICATE_KEY_SECRET).eq("ownerId", certificate._id),
			)
			.unique();
		if (!chain || !secret) throw new ConvexError("Certificate data missing");
		return {
			certificatePath: certificate.certificatePath,
			certificateData: chain.certificateData,
			privateKey: await decryptSecret(secret),
		};
	},
});

export const getTraefikDesired = query({
	args: lease,
	handler: async (ctx, args) => {
		const { job } = await requireSpec(ctx, args, [
			"infra.traefikApply",
			"infra.serverSetup",
		]);
		const settings = await loadTraefikSettings(ctx, serverIdOf(job));
		let env: string | null = null;
		if (settings?.envManaged) {
			const secret = await ctx.db
				.query("secrets")
				.withIndex("by_kind_and_ownerId", (q) =>
					q.eq("kind", TRAEFIK_ENV_SECRET).eq("ownerId", settings._id),
				)
				.unique();
			env = secret ? await decryptSecret(secret) : null;
		}
		return {
			additionalPorts: settings?.additionalPorts ?? [],
			dashboardEnabled: settings?.dashboardEnabled ?? false,
			env,
		};
	},
});

export const getWebServerConfig = query({
	args: lease,
	handler: async (ctx, args) => {
		await requireSpec(ctx, args, ["infra.webServerApply", "infra.serverSetup"]);
		const settings = await loadWebServerSettings(ctx);
		return {
			host: settings?.host ?? null,
			https: settings?.https ?? false,
			certificateType: settings?.certificateType ?? ("none" as const),
			letsEncryptEmail: settings?.letsEncryptEmail ?? null,
		};
	},
});

export const getOpInput = query({
	args: lease,
	handler: async (ctx, args) => {
		await requireLease(ctx, args.jobId, args.leaseId);
		const op = await ctx.db
			.query("infraOps")
			.withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
			.unique();
		return op?.input ?? null;
	},
});

export const getSecurityContext = query({
	args: lease,
	handler: async (ctx, args) => {
		const { job } = await requireSpec(ctx, args, [
			"infra.serverSecurity",
			"infra.inspect",
		]);
		const settings = await loadWebServerSettings(ctx);
		const serverId = serverIdOf(job);
		const server = serverId ? await ctx.db.get("servers", serverId) : null;
		const sshKey = server?.sshKeyId
			? await ctx.db.get("sshKeys", server.sshKeyId)
			: null;
		return {
			panelIps: settings?.serverIp ? [settings.serverIp] : [],
			username: server?.username ?? null,
			port: server?.port ?? null,
			panelPublicKey: sshKey?.publicKey ?? null,
		};
	},
});

export const getNetwork = query({
	args: lease,
	handler: async (ctx, args) => {
		const { spec } = await requireSpec(ctx, args, ["infra.dockerAction"]);
		if (spec.action.type !== "networkCreate") {
			throw new ConvexError("Not a network job");
		}
		return await ctx.db.get("networks", spec.action.networkId);
	},
});

const assertPayloadSize = (value: string) => {
	if (value.length > MAX_PAYLOAD_CHARS) {
		throw new ConvexError("Payload too large");
	}
};

type SnapshotFields = {
	organizationId: string;
	serverId: Doc<"servers">["_id"] | undefined;
	kind: Doc<"infraSnapshots">["kind"];
	data: string;
	error?: string;
	jobId?: Doc<"jobs">["_id"];
};

const findSnapshot = (
	ctx: MutationCtx,
	serverId: Doc<"servers">["_id"] | undefined,
	kind: Doc<"infraSnapshots">["kind"],
) =>
	ctx.db
		.query("infraSnapshots")
		.withIndex("by_serverId_and_kind", (q) =>
			q.eq("serverId", serverId).eq("kind", kind),
		)
		.unique();

const writeSnapshot = async (
	ctx: MutationCtx,
	existing: Doc<"infraSnapshots"> | null,
	snapshot: SnapshotFields,
) => {
	const fields = {
		...snapshot,
		error: snapshot.error?.slice(0, 4000),
		refreshedAt: Date.now(),
	};
	if (existing && fields.error) {
		// Keep the last good data so the UI can show it next to the error.
		await ctx.db.patch("infraSnapshots", existing._id, {
			error: fields.error,
			refreshedAt: fields.refreshedAt,
			jobId: fields.jobId,
		});
	} else if (existing) {
		await ctx.db.replace("infraSnapshots", existing._id, fields);
	} else {
		await ctx.db.insert("infraSnapshots", fields);
	}
};

export const reportSnapshot = mutation({
	args: {
		...lease,
		kind: snapshotKind,
		data: v.string(),
		error: v.optional(v.string()),
	},
	handler: async (ctx, { jobId, leaseId, kind, data, error }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		if (!job.spec.kind.startsWith("infra.")) {
			throw new ConvexError("Not an infra job");
		}
		assertPayloadSize(data);
		const serverId = serverIdOf(job);
		await writeSnapshot(ctx, await findSnapshot(ctx, serverId, kind), {
			organizationId: job.organizationId,
			serverId,
			kind,
			data,
			error,
			jobId,
		});
	},
});

// An unchanged reading is written again only this often, so an open page
// keeps `refreshedAt` recent without rewriting the row on every read.
export const LIVE_SNAPSHOT_REWRITE_MS = 60_000;

// Written by the agent while a `hostSnapshot` live session is open. Host and
// kind come from the stored session, so an agent can only write what it was
// asked to watch. `force` (a session's first read, a Refresh press) always
// writes, so a page can tell a reading taken after it opened. Returns
// whether the row was written.
export const reportLiveSnapshot = mutation({
	args: {
		sessionId: v.id("liveSessions"),
		data: v.string(),
		error: v.optional(v.string()),
		force: v.optional(v.boolean()),
	},
	handler: async (ctx, { sessionId, data, error, force }) => {
		const agent = await requireAgent(ctx);
		const session = await ctx.db.get("liveSessions", sessionId);
		if (
			!session ||
			session.agentId !== agent._id ||
			session.status !== "open" ||
			session.request.kind !== "hostSnapshot"
		) {
			throw new ConvexError("Not an open snapshot session");
		}
		assertPayloadSize(data);
		const { serverId, what } = session.request;
		const existing = await findSnapshot(ctx, serverId, what);
		const unchanged =
			existing !== null &&
			(error === undefined
				? existing.error === undefined && existing.data === data
				: existing.error === error.slice(0, 4000));
		if (
			!force &&
			unchanged &&
			Date.now() - existing.refreshedAt < LIVE_SNAPSHOT_REWRITE_MS
		) {
			return false;
		}
		await writeSnapshot(ctx, existing, {
			organizationId: session.organizationId,
			serverId,
			kind: what,
			data,
			error,
		});
		return true;
	},
});

export const reportOpResult = mutation({
	args: {
		...lease,
		result: v.optional(v.string()),
		error: v.optional(v.string()),
	},
	handler: async (ctx, { jobId, leaseId, result, error }) => {
		await requireLease(ctx, jobId, leaseId);
		if (result !== undefined) assertPayloadSize(result);
		const op = await ctx.db
			.query("infraOps")
			.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
			.unique();
		if (!op) throw new ConvexError("No result slot for this job");
		await ctx.db.patch("infraOps", op._id, {
			result,
			error: error?.slice(0, 4000),
			completedAt: Date.now(),
		});
	},
});

export const reportNetwork = mutation({
	args: {
		...lease,
		dockerId: v.optional(v.string()),
		error: v.optional(v.string()),
	},
	handler: async (ctx, { jobId, leaseId, dockerId, error }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		if (
			job.spec.kind !== "infra.dockerAction" ||
			job.spec.action.type !== "networkCreate"
		) {
			throw new ConvexError("Not a network job");
		}
		const network = await ctx.db.get("networks", job.spec.action.networkId);
		if (!network) return;
		await ctx.db.patch("networks", network._id, {
			dockerId,
			status: error ? "error" : "created",
			error: error?.slice(0, 4000),
		});
	},
});

const MAX_VOLUMES_CHECKED = 200;

// For a removal that also deletes volumes: the services still defined in the
// panel on the job's server whose definition names each volume. Read while the
// job runs, so a service deleted in the meantime no longer counts. Services of
// another organization on the same server count but are not named.
export const volumeReferences = query({
	args: { ...lease, volumeNames: v.array(v.string()) },
	handler: async (ctx, { volumeNames, ...args }) => {
		const { job } = await requireSpec(ctx, args, [
			"compose.remove",
			"application.remove",
			"databases.remove",
		]);
		if (volumeNames.length > MAX_VOLUMES_CHECKED) {
			throw new ConvexError(`At most ${MAX_VOLUMES_CHECKED} volumes at once`);
		}
		const { users, complete } = await volumeUsers(
			ctx,
			serverIdOf(job),
			volumeNames,
		);
		return {
			incomplete: complete ? null : TOO_MANY_COMPOSE_SERVICES,
			volumes: [...users].map(([volumeName, services]) => ({
				volumeName,
				services: services.map((service) => ({
					appName: service.appName,
					label: volumeUserLabel(
						service,
						service.organizationId === job.organizationId,
					),
				})),
			})),
		};
	},
});
