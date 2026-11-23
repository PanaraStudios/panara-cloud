import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { registerApplicationsCrons } from "./applications/crons";
import { registerComposeCrons } from "./compose/crons";
import { registerDatabasesCrons } from "./databases/crons";
import { registerInfraCrons } from "./infra/crons";
import { registerLiveCrons } from "./live/crons";
import { registerPlatformCrons } from "./platform/crons";
import { registerSourcesCrons } from "./sources/crons";

const crons = cronJobs();

crons.interval(
	"reap expired job leases",
	{ seconds: 30 },
	internal.jobs.reapExpiredLeases,
	{},
);

// Finished housekeeping jobs after 7 days, deployment history beyond the
// newest 100 per target (jobRetention.ts).
crons.interval(
	"prune finished jobs",
	{ hours: 1 },
	internal.jobRetention.prune,
	{},
);

crons.interval(
	"prune service events",
	{ hours: 6 },
	internal.serviceEvents.prune,
	{},
);

registerInfraCrons(crons);
registerSourcesCrons(crons);
registerPlatformCrons(crons);
registerApplicationsCrons(crons);
registerComposeCrons(crons);
registerDatabasesCrons(crons);
registerLiveCrons(crons);

export default crons;
