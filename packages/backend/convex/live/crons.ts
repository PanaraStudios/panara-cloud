import type { Crons } from "convex/server";
import { internal } from "../_generated/api";

export const registerLiveCrons = (crons: Crons) => {
	crons.interval(
		"expire live sessions",
		{ minutes: 1 },
		internal.live.cleanup.expireSessions,
		{},
	);
	crons.interval(
		"prune monitoring history",
		{ hours: 1 },
		internal.live.monitoringHistory.prune,
		{},
	);
	// Each host's own cleanup cron decides whether a truncation is due.
	crons.interval(
		"truncate traefik access logs",
		{ minutes: 1 },
		internal.live.accessLog.enqueueCleanups,
		{},
	);
};
