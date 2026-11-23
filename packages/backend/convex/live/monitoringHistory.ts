import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, mutation, query } from "../_generated/server";
import { requireAgent } from "../lib/agentAuth";
import { liveRequest, monitoringSample } from "../tables/live";
import type { LiveRequest, LiveRestriction } from "./lib";
import { authorizeRequest } from "./sessions";

// Keeps the last 288 readings per app.
export const HISTORY_POINTS = 288;
export const SAMPLE_INTERVAL_MS = 10_000;
export const RETENTION_MS = 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 500;

type StatsRequest = Extract<LiveRequest, { kind: "containerStats" }>;

// What a stats stream watches, as the key its history is stored under.
// Restricted (member) and unrestricted (admin) viewers keep separate
// histories so a member never reads samples of containers the agent's label
// check would have refused them.
export const statsKey = (input: {
	organizationId: string;
	partition: string;
	restriction?: LiveRestriction | null;
	request: StatsRequest;
}): string | null => {
	const { request } = input;
	const target =
		request.target.type === "host"
			? "host"
			: request.target.type === "service"
				? `service:${request.target.serviceName}`
				: request.target.type === "container"
					? `container:${request.target.containerId}`
					: null;
	if (!target) return null;
	const scope =
		request.scope.type === "service"
			? `service:${request.scope.serviceId}`
			: "host";
	return [
		input.organizationId,
		input.partition,
		input.restriction ? "restricted" : "all",
		scope,
		target,
	].join("|");
};

// The stored history of what a stats session
// would stream, oldest first. Authorized exactly like opening that session.
export const history = query({
	args: { request: liveRequest },
	handler: async (ctx, { request }) => {
		if (request.kind !== "containerStats") {
			throw new ConvexError("History is only kept for container stats");
		}
		const scope = await authorizeRequest(ctx, request);
		const key = statsKey({ ...scope, request });
		if (!key) return [];
		const rows = await ctx.db
			.query("monitoringSamples")
			.withIndex("by_key_and_at", (q) => q.eq("key", key))
			.order("desc")
			.take(HISTORY_POINTS);
		return rows.reverse().map((row) => ({ at: row.at, sample: row.sample }));
	},
});

const openStatsSession = async (
	session: Doc<"liveSessions"> | null,
	agentId: Id<"agents">,
) => {
	if (
		!session ||
		session.agentId !== agentId ||
		session.status !== "open" ||
		session.request.kind !== "containerStats"
	) {
		throw new ConvexError("Not an open stats session");
	}
	return { ...session, request: session.request };
};

// Called by the agent while a stats session streams. The key comes from the
// stored session, so an agent can only add history for what it was asked
// to watch; readings closer than SAMPLE_INTERVAL_MS to the last one (another
// viewer of the same target) are dropped.
export const record = mutation({
	args: { sessionId: v.id("liveSessions"), sample: monitoringSample },
	handler: async (ctx, { sessionId, sample }) => {
		const agent = await requireAgent(ctx);
		const session = await openStatsSession(
			await ctx.db.get("liveSessions", sessionId),
			agent._id,
		);
		const key = statsKey(session);
		if (!key) return false;
		const now = Date.now();
		const latest = await ctx.db
			.query("monitoringSamples")
			.withIndex("by_key_and_at", (q) => q.eq("key", key))
			.order("desc")
			.first();
		if (latest && latest.at > now - SAMPLE_INTERVAL_MS) return false;
		await ctx.db.insert("monitoringSamples", {
			organizationId: session.organizationId,
			key,
			at: now,
			sample,
		});
		return true;
	},
});

export const prune = internalMutation({
	args: {},
	handler: async (ctx) => {
		const old = await ctx.db
			.query("monitoringSamples")
			.withIndex("by_at", (q) => q.lt("at", Date.now() - RETENTION_MS))
			.take(PRUNE_BATCH);
		for (const row of old) await ctx.db.delete("monitoringSamples", row._id);
		if (old.length === PRUNE_BATCH) {
			await ctx.scheduler.runAfter(
				0,
				internal.live.monitoringHistory.prune,
				{},
			);
		}
		return old.length;
	},
});
