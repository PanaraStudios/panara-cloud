import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import type { ConvexClient } from "convex/browser";
import { type LiveServer, startLiveServer } from "./server";

export type { LiveServer };

const sessionId = (id: string) => id as Id<"liveSessions">;

// Starts the browser-facing WebSocket endpoint (`/live?token=...`). Disabled
// with LIVE_ENABLED=false; listens on LIVE_HOST:LIVE_PORT (default 0.0.0.0:7100).
export const startLive = async (
	client: ConvexClient,
	log: (message: string) => void,
): Promise<LiveServer | null> => {
	if (process.env.LIVE_ENABLED === "false") return null;
	const closedOnStart = await client.mutation(api.live.agent.resetSessions, {});
	if (closedOnStart > 0) log(`Closed ${closedOnStart} stale live session(s)`);
	const server = startLiveServer({
		port: Number(process.env.LIVE_PORT ?? 7100),
		host: process.env.LIVE_HOST,
		allowedOrigins: (process.env.LIVE_ALLOWED_ORIGINS ?? "")
			.split(",")
			.map((origin) => origin.trim())
			.filter(Boolean),
		redeem: (token) => client.mutation(api.live.agent.redeem, { token }),
		reportClosed: (id, reason) =>
			client.mutation(api.live.agent.closed, {
				sessionId: sessionId(id),
				reason,
			}),
		services: {
			touchSandbox: (id) =>
				client.mutation(api.live.agent.touchSandbox, {
					sessionId: sessionId(id),
				}),
			sandboxGone: async (id) => {
				await client.mutation(api.live.agent.sandboxGone, {
					sessionId: sessionId(id),
				});
			},
			recordStats: (id, sample) =>
				client.mutation(api.live.monitoringHistory.record, {
					sessionId: sessionId(id),
					sample,
				}),
		},
		log,
	});
	client.onUpdate(
		api.live.agent.killRequests,
		{},
		(ids) => {
			for (const id of ids) server.kill(id);
		},
		(error) => log(`Live kill subscription error: ${error.message}`),
	);
	log(`Live endpoint listening on port ${await server.listening}`);
	return server;
};
