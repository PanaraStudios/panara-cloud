import type { Crons } from "convex/server";
import { internal } from "../_generated/api";

export const registerPlatformCrons = (crons: Crons) => {
	// Backstop for lost scheduler state (e.g. after a snapshot import); a no-op
	// for schedules that already have a pending run.
	crons.interval(
		"reconcile user schedules",
		{ minutes: 10 },
		internal.platform.schedules.reconcileSchedules,
		{},
	);
	crons.interval(
		"refresh template catalog",
		{ hours: 6 },
		internal.platform.templatesSync.refreshCatalog,
		{},
	);
};
