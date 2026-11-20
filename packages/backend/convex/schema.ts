import { defineSchema } from "convex/server";
import { v } from "convex/values";
import {
	applicationsJobSpecs,
	applicationsTables,
} from "./tables/applications";
import { composeJobSpecs, composeTables } from "./tables/compose";
import { coreJobSpecs, coreTables, makeJobsTable } from "./tables/core";
import { databasesJobSpecs, databasesTables } from "./tables/databases";
import { emailTables } from "./tables/email";
import { infraJobSpecs, infraTables } from "./tables/infra";
import { liveJobSpecs, liveTables } from "./tables/live";
import { platformJobSpecs, platformTables } from "./tables/platform";
import { serviceEventsTables } from "./tables/serviceEvents";
import { sourcesJobSpecs, sourcesTables } from "./tables/sources";

export { jobStatus, LOCAL_PARTITION, memberRole } from "./tables/core";

export const jobSpec = v.union(
	...coreJobSpecs,
	...infraJobSpecs,
	...sourcesJobSpecs,
	...platformJobSpecs,
	...applicationsJobSpecs,
	...composeJobSpecs,
	...databasesJobSpecs,
	...liveJobSpecs,
);

export default defineSchema({
	...coreTables,
	...infraTables,
	...sourcesTables,
	...platformTables,
	...applicationsTables,
	...composeTables,
	...databasesTables,
	...liveTables,
	...serviceEventsTables,
	...emailTables,
	jobs: makeJobsTable(jobSpec),
});
