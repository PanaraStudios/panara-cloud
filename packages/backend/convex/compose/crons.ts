import type { Crons } from "convex/server";
import { internal } from "../_generated/api";

export const registerComposeCrons = (crons: Crons) => {
	crons.interval(
		"compose: delete old load-services/convert results",
		{ hours: 6 },
		internal.compose.deploy.gcOps,
		{},
	);
};
