import type { Crons } from "convex/server";
import { internal } from "../_generated/api";

export const registerDatabasesCrons = (crons: Crons) => {
	// Backstops for lost scheduler state (e.g. after a snapshot import); no-ops
	// for backups that already have a pending run.
	crons.interval(
		"databases: reconcile backup schedules",
		{ minutes: 10 },
		internal.databases.backups.reconcileBackups,
		{},
	);
	crons.interval(
		"databases: reconcile volume backup schedules",
		{ minutes: 10 },
		internal.databases.volumeBackups.reconcileVolumeBackups,
		{},
	);
	crons.interval(
		"databases: reconcile panel backup schedules",
		{ minutes: 10 },
		internal.databases.panelBackups.reconcilePanelBackups,
		{},
	);
	crons.interval(
		"databases: expire one-off op results",
		{ minutes: 30 },
		internal.databases.destinations.expireOps,
		{},
	);
};
