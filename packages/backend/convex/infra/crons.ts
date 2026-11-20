import type { Crons } from "convex/server";
import { internal } from "../_generated/api";

export const registerInfraCrons = (crons: Crons) => {
	// Daily Docker cleanup ("50 23 * * *"), in UTC.
	crons.cron(
		"infra: scheduled docker cleanup",
		"50 23 * * *",
		internal.infra.cleanup.enqueueScheduledCleanups,
		{},
	);
	crons.interval(
		"infra: expire one-off op results",
		{ minutes: 30 },
		internal.infra.cleanup.expireOps,
		{},
	);
	crons.interval(
		"infra: expire server connect tokens",
		{ minutes: 30 },
		internal.infra.connect.expireTokens,
		{},
	);
};
