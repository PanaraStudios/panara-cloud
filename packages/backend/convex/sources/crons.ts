import type { Crons } from "convex/server";
import { internal } from "../_generated/api";

export const registerSourcesCrons = (crons: Crons) => {
	// Housekeeping only: an expired state is refused when used.
	crons.interval(
		"sources: expire OAuth states",
		{ hours: 6 },
		internal.sources.oauthStates.cleanupExpired,
		{},
	);
	crons.interval(
		"sources: clean up registry tests",
		{ hours: 1 },
		internal.sources.registries.cleanupTests,
		{},
	);
};
