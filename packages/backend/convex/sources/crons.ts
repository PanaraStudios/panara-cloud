import type { Crons } from "convex/server";
import { internal } from "../_generated/api";

export const registerSourcesCrons = (crons: Crons) => {
	crons.interval(
		"sources: expire OAuth states",
		{ minutes: 30 },
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
