import { ConvexError, type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
import { onServerRemoved } from "./infra/cleanup";
import { enqueueOp } from "./infra/hostJobs";
import { requireMember } from "./lib/access";
import { enqueueJob } from "./lib/jobs";
import { requirePermission } from "./lib/permissions";

const MAX_SERVERS = 500;

const serverFields = {
	name: v.string(),
	description: v.optional(v.string()),
	ipAddress: v.string(),
	port: v.number(),
	username: v.string(),
	sshKeyId: v.optional(v.id("sshKeys")),
	serverType: v.union(v.literal("deploy"), v.literal("build")),
	enableDockerCleanup: v.boolean(),
};

const serverFieldsValidator = v.object(serverFields);

const validateFields = async (
	ctx: MutationCtx,
	organizationId: string,
	fields: {
		name: string;
		ipAddress: string;
		port: number;
		username: string;
		sshKeyId?: Id<"sshKeys">;
	},
) => {
	if (!fields.name.trim()) throw new ConvexError("Name is required");
	if (!fields.ipAddress.trim()) throw new ConvexError("Address is required");
	if (
		!Number.isInteger(fields.port) ||
		fields.port < 1 ||
		fields.port > 65535
	) {
		throw new ConvexError("Port must be between 1 and 65535");
	}
	if (!/^[a-z_][a-z0-9_-]*$/i.test(fields.username)) {
		throw new ConvexError("Invalid SSH username");
	}
	if (fields.sshKeyId) {
		const key = await ctx.db.get("sshKeys", fields.sshKeyId);
		if (!key || key.organizationId !== organizationId) {
			throw new ConvexError("SSH key not found");
		}
	}
};

export const list = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requireMember(ctx, organizationId);
		return await ctx.db
			.query("servers")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", organizationId),
			)
			.take(MAX_SERVERS);
	},
});

// Includes the attached key's public half so
// the setup screen can show the authorized_keys line.
export const get = query({
	args: { serverId: v.id("servers") },
	handler: async (ctx, { serverId }) => {
		const server = await ctx.db.get("servers", serverId);
		if (!server) return null;
		await requirePermission(ctx, server.organizationId, "server", "read");
		const key = server.sshKeyId
			? await ctx.db.get("sshKeys", server.sshKeyId)
			: null;
		return {
			...server,
			sshKey: key ? { name: key.name, publicKey: key.publicKey } : null,
		};
	},
});

const MAX_SERVICES_PER_KIND = 200;

// What still runs on (or builds on) a server,
// so it can be cleaned up before the server is removed.
export const services = query({
	args: { serverId: v.id("servers") },
	handler: async (ctx, { serverId }) => {
		const server = await ctx.db.get("servers", serverId);
		if (!server) return [];
		await requirePermission(ctx, server.organizationId, "server", "read");
		const [applications, builds, compose, databases] = await Promise.all([
			ctx.db
				.query("applications")
				.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
				.take(MAX_SERVICES_PER_KIND),
			ctx.db
				.query("applications")
				.withIndex("by_buildServerId", (q) => q.eq("buildServerId", serverId))
				.take(MAX_SERVICES_PER_KIND),
			ctx.db
				.query("compose")
				.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
				.take(MAX_SERVICES_PER_KIND),
			ctx.db
				.query("databases")
				.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
				.take(MAX_SERVICES_PER_KIND),
		]);
		const seen = new Set<string>();
		const result: {
			type: "application" | "compose" | Doc<"databases">["engine"];
			id: string;
			name: string;
			projectId: Id<"projects">;
			environmentId: Id<"environments">;
		}[] = [];
		for (const app of [...applications, ...builds]) {
			if (seen.has(app._id)) continue;
			seen.add(app._id);
			result.push({
				type: "application",
				id: app._id,
				name: app.name,
				projectId: app.projectId,
				environmentId: app.environmentId,
			});
		}
		for (const row of compose) {
			result.push({
				type: "compose",
				id: row._id,
				name: row.name,
				projectId: row.projectId,
				environmentId: row.environmentId,
			});
		}
		for (const db of databases) {
			result.push({
				type: db.engine,
				id: db._id,
				name: db.name,
				projectId: db.projectId,
				environmentId: db.environmentId,
			});
		}
		return result;
	},
});

export const insertServer = async (
	ctx: MutationCtx,
	organizationId: string,
	fields: Infer<typeof serverFieldsValidator>,
) => {
	await validateFields(ctx, organizationId, fields);
	return await ctx.db.insert("servers", {
		organizationId,
		...fields,
		name: fields.name.trim(),
		ipAddress: fields.ipAddress.trim(),
		buildsConcurrency: 1,
		serverStatus: "active",
	});
};

export const create = mutation({
	args: { organizationId: v.string(), ...serverFields },
	handler: async (ctx, { organizationId, ...fields }) => {
		await requirePermission(ctx, organizationId, "server", "create");
		return await insertServer(ctx, organizationId, fields);
	},
});

export const update = mutation({
	args: { serverId: v.id("servers"), ...serverFields },
	handler: async (ctx, { serverId, ...fields }) => {
		const server = await ctx.db.get("servers", serverId);
		if (!server) throw new ConvexError("Server not found");
		await requirePermission(ctx, server.organizationId, "server", "create");
		if (server.serverStatus === "inactive") {
			throw new ConvexError("Server is inactive");
		}
		await validateFields(ctx, server.organizationId, fields);
		const ipAddress = fields.ipAddress.trim();
		const moved = ipAddress !== server.ipAddress || fields.port !== server.port;
		await ctx.db.patch("servers", serverId, {
			...fields,
			name: fields.name.trim(),
			ipAddress,
			// A new address is a new machine: its key is learned again.
			...(moved ? { sshHostKey: undefined } : {}),
		});
	},
});

// After a server is reinstalled its SSH host key changes and the agent
// refuses to connect; this forgets the old key so the next connection
// records the new one.
export const resetHostKey = mutation({
	args: { serverId: v.id("servers") },
	handler: async (ctx, { serverId }) => {
		const server = await ctx.db.get("servers", serverId);
		if (!server) throw new ConvexError("Server not found");
		await requirePermission(ctx, server.organizationId, "server", "create");
		await ctx.db.patch("servers", serverId, { sshHostKey: undefined });
	},
});

export const setBuildsConcurrency = mutation({
	args: { serverId: v.id("servers"), buildsConcurrency: v.number() },
	handler: async (ctx, { serverId, buildsConcurrency }) => {
		const server = await ctx.db.get("servers", serverId);
		if (!server) throw new ConvexError("Server not found");
		await requirePermission(ctx, server.organizationId, "server", "create");
		if (
			!Number.isInteger(buildsConcurrency) ||
			buildsConcurrency < 1 ||
			buildsConcurrency > 100
		) {
			throw new ConvexError("Builds concurrency must be between 1 and 100");
		}
		await ctx.db.patch("servers", serverId, { buildsConcurrency });
	},
});

export const remove = mutation({
	args: { serverId: v.id("servers") },
	handler: async (ctx, { serverId }) => {
		const server = await ctx.db.get("servers", serverId);
		if (!server) return;
		await requirePermission(ctx, server.organizationId, "server", "delete");
		const active = await ctx.db
			.query("jobs")
			.withIndex("by_partition_and_status", (q) =>
				q.eq("partition", serverId).eq("status", "running"),
			)
			.first();
		if (active) {
			throw new ConvexError("Server has running jobs; wait for them to finish");
		}
		const inUse =
			(await ctx.db
				.query("applications")
				.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
				.first()) ??
			(await ctx.db
				.query("applications")
				.withIndex("by_buildServerId", (q) => q.eq("buildServerId", serverId))
				.first()) ??
			(await ctx.db
				.query("compose")
				.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
				.first()) ??
			(await ctx.db
				.query("databases")
				.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
				.first());
		if (inUse) {
			throw new ConvexError(
				`Server still runs "${inUse.name}"; move or delete its services first`,
			);
		}
		await ctx.db.delete("servers", serverId);
		await onServerRemoved(ctx, server);
		await ctx.scheduler.runAfter(0, internal.live.cleanup.removeForServer, {
			serverId,
		});
		await ctx.scheduler.runAfter(
			0,
			internal.platform.schedules.removeForTarget,
			{
				targetId: serverId,
			},
		);
		const vectorTargets = await ctx.db
			.query("vectorTargets")
			.withIndex("by_organizationId", (q) =>
				q.eq("organizationId", server.organizationId),
			)
			.take(500);
		for (const target of vectorTargets) {
			if (target.serverId === serverId) {
				await ctx.db.delete("vectorTargets", target._id);
			}
		}
	},
});

export const validate = mutation({
	args: { serverId: v.id("servers") },
	handler: async (ctx, { serverId }) => {
		const server = await ctx.db.get("servers", serverId);
		if (!server) throw new ConvexError("Server not found");
		const { userId } = await requirePermission(
			ctx,
			server.organizationId,
			"server",
			"read",
		);
		if (!server.sshKeyId) {
			throw new ConvexError("Attach an SSH key before validating the server");
		}
		if (server.serverStatus === "inactive") {
			throw new ConvexError("Server is inactive");
		}
		return await enqueueJob(ctx, {
			organizationId: server.organizationId,
			partition: serverId,
			group: `server:${serverId}`,
			spec: { kind: "server.validate", serverId },
			idempotent: true,
			maxAttempts: 3,
			requestedBy: userId,
		});
	},
});

// Server status. An inactive server keeps its services (shown with
// a red server badge) but can't be updated, set up or cleaned until it is
// active again.
export const setStatus = mutation({
	args: {
		serverId: v.id("servers"),
		serverStatus: v.union(v.literal("active"), v.literal("inactive")),
	},
	handler: async (ctx, { serverId, serverStatus }) => {
		const server = await ctx.db.get("servers", serverId);
		if (!server) throw new ConvexError("Server not found");
		await requirePermission(ctx, server.organizationId, "server", "create");
		await ctx.db.patch("servers", serverId, { serverStatus });
	},
});

const MAX_SETUP_SCRIPT = 256 * 1024;

// The server's custom setup script; null means the
// default script runs.
export const getSetupScript = query({
	args: { serverId: v.id("servers") },
	handler: async (ctx, { serverId }) => {
		const server = await ctx.db.get("servers", serverId);
		if (!server) return null;
		await requirePermission(ctx, server.organizationId, "server", "read");
		const row = await ctx.db
			.query("serverSetupScripts")
			.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
			.unique();
		return row?.script ?? null;
	},
});

// An empty script goes back to the default.
export const setSetupScript = mutation({
	args: { serverId: v.id("servers"), script: v.string() },
	handler: async (ctx, { serverId, script }) => {
		const server = await ctx.db.get("servers", serverId);
		if (!server) throw new ConvexError("Server not found");
		await requirePermission(ctx, server.organizationId, "server", "create");
		if (script.length > MAX_SETUP_SCRIPT) {
			throw new ConvexError("Script is too large");
		}
		const row = await ctx.db
			.query("serverSetupScripts")
			.withIndex("by_serverId", (q) => q.eq("serverId", serverId))
			.unique();
		if (!script.trim()) {
			if (row) await ctx.db.delete("serverSetupScripts", row._id);
		} else if (row) {
			await ctx.db.patch("serverSetupScripts", row._id, { script });
		} else {
			await ctx.db.insert("serverSetupScripts", {
				organizationId: server.organizationId,
				serverId,
				script,
			});
		}
	},
});

// The default setup script. The script is built by the agent, so
// this queues a job whose result (snapshots.opResult) is the script text.
export const requestDefaultSetupScript = mutation({
	args: { serverId: v.id("servers") },
	handler: async (ctx, { serverId }) => {
		const server = await ctx.db.get("servers", serverId);
		if (!server) throw new ConvexError("Server not found");
		const { userId } = await requirePermission(
			ctx,
			server.organizationId,
			"server",
			"read",
		);
		return await enqueueOp(
			ctx,
			{ organizationId: server.organizationId, partition: serverId, userId },
			`setupScript:${serverId}`,
			{ kind: "infra.setupScript", serverId },
			{ restricted: false, idempotent: true },
		);
	},
});
