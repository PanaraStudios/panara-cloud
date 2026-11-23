import type { Crons } from "convex/server";
import { internal } from "../_generated/api";

export const registerLiveCrons = (crons: Crons) => {
	// Housekeeping only: a token is refused once past its connectBy, and the
	// per-user session cap does not count expired ones.
	crons.interval(
		"expire live sessions",
		{ minutes: 15 },
		internal.live.cleanup.expireSessions,
		{},
	);
	crons.interval(
		"prune monitoring history",
		{ hours: 1 },
		internal.live.monitoringHistory.prune,
		{},
	);
	// Each host's truncation is a scheduled run at its own cron's time; this
	// is the backstop for lost scheduler state.
	crons.interval(
		"truncate traefik access logs",
		{ hours: 1 },
		internal.live.accessLog.enqueueCleanups,
		{},
	);
};
