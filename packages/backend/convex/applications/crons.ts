import type { Crons } from "convex/server";
import { internal } from "../_generated/api";

export const registerApplicationsCrons = (crons: Crons) => {
	crons.interval(
		"applications: settle stuck statuses",
		{ minutes: 5 },
		internal.applications.status.settleStuck,
		{},
	);
	crons.interval(
		"applications: collect op results",
		{ hours: 1 },
		internal.applications.patchRepo.collectOps,
		{},
	);
};
