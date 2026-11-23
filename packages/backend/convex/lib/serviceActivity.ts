import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

type JobKind = Doc<"jobs">["spec"]["kind"];

export type ServiceActivityKind =
	| "deploying"
	| "rollingBack"
	| "transferring"
	| "starting"
	| "stopping"
	| "restarting"
	| "backingUp"
	| "restoring";

// Jobs that change whether or how the service runs. Housekeeping in the same
// group (routing sync, image cleanup, compose file reads) is left out: it
// neither blocks nor explains anything the user can do.
const ACTIVITY: Partial<Record<JobKind, ServiceActivityKind>> = {
	"application.deploy": "deploying",
	"application.redeploy": "deploying",
	"application.rollback": "rollingBack",
	"application.transfer": "transferring",
	"application.reload": "restarting",
	"application.start": "starting",
	"application.stop": "stopping",
	"compose.deploy": "deploying",
	"compose.redeploy": "deploying",
	"compose.transfer": "transferring",
	"compose.start": "starting",
	"compose.stop": "stopping",
	"databases.deploy": "deploying",
	"databases.rebuild": "deploying",
	"databases.transfer": "transferring",
	"databases.reload": "restarting",
	"databases.start": "starting",
	"databases.stop": "stopping",
	"databases.backupRun": "backingUp",
	"databases.volumeBackupRun": "backingUp",
	"databases.restore": "restoring",
	"databases.volumeRestore": "restoring",
};

const QUEUED_SCAN = 20;

export type ServiceActivity = {
	kind: ServiceActivityKind;
	status: "queued" | "running";
	jobId: Id<"jobs">;
	cancelRequested: boolean;
	// How many more lifecycle jobs wait behind this one.
	waiting: number;
};

// The jobs of a group that are running or waiting, in the order the group
// takes them.
export const activeJobs = async (ctx: QueryCtx, group: string) => {
	const running = await ctx.db
		.query("jobs")
		.withIndex("by_group_and_status", (q) =>
			q.eq("group", group).eq("status", "running"),
		)
		.take(QUEUED_SCAN);
	const queued = await ctx.db
		.query("jobs")
		.withIndex("by_group_and_status", (q) =>
			q.eq("group", group).eq("status", "queued"),
		)
		.take(QUEUED_SCAN);
	return [...running, ...queued];
};

export const activityOf = (active: Doc<"jobs">[]): ServiceActivity | null => {
	const jobs = active.filter((job) => ACTIVITY[job.spec.kind]);
	const current = jobs[0];
	if (!current) return null;
	return {
		kind: ACTIVITY[current.spec.kind] as ServiceActivityKind,
		status: current.status === "running" ? "running" : "queued",
		jobId: current._id,
		cancelRequested: current.cancelRequested,
		waiting: jobs.length - 1,
	};
};

// What a service is busy with: the running job of its group, else the first
// one waiting. A group runs one job at a time, so anything started meanwhile
// waits behind it.
export const serviceActivity = async (
	ctx: QueryCtx,
	group: string,
): Promise<ServiceActivity | null> => activityOf(await activeJobs(ctx, group));

// Jobs that put a service on its host. Each service has its own group, so
// only its own kinds are ever found.
const DEPLOY_KINDS: readonly JobKind[] = [
	"application.deploy",
	"application.redeploy",
	"compose.deploy",
	"compose.redeploy",
	"databases.deploy",
	"databases.rebuild",
];

export const hasDeployed = async (ctx: QueryCtx, group: string) => {
	for (const kind of DEPLOY_KINDS) {
		const succeeded = await ctx.db
			.query("jobs")
			.withIndex("by_group_and_kind_and_status", (q) =>
				q.eq("group", group).eq("spec.kind", kind).eq("status", "succeeded"),
			)
			.first();
		if (succeeded) return true;
	}
	return false;
};

export const NOTHING_DEPLOYED = "Nothing is deployed yet. Deploy first.";

// Restart, start and stop act on what a deploy created. Until one has
// succeeded there is nothing on the host, and the job would make a service
// from settings no deploy has prepared (no image, no files, no routing).
// `done` is trusted on its own: it is only ever set by a job that left the
// service running.
export const assertDeployed = async (
	ctx: QueryCtx,
	service: { status: "idle" | "running" | "done" | "error" },
	group: string,
) => {
	if (service.status === "done") return;
	if (!(await hasDeployed(ctx, group))) throw new ConvexError(NOTHING_DEPLOYED);
};
