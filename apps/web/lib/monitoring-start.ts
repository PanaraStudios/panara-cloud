// After "Set up monitoring" the collector's image is pulled and its container
// started; until it answers, a read of the metrics fails with the errors of a
// service that is not there yet. For this long after the set-up that is
// "starting", not a failure.
export const STARTING_WINDOW_MS = 3 * 60_000;

// How often the charts try again while they have nothing to show.
export const METRICS_RETRY_MS = 5000;

// On another server the agent reaches the collector through its SSH
// connection, and a port nobody listens on yet reads "(SSH) Channel open
// failure: Connection refused" instead of ECONNREFUSED.
const NOT_ANSWERING =
	/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|Connection refused|Channel open failure|did not answer|fetch failed|socket hang up|timed out/i;

// When the monitoring service was last set up, from its job: now while the
// job is still queued or running, null when that isn't known.
export const monitoringDeployedAt = (
	job:
		| { status: string; finishedAt?: number; _creationTime: number }
		| null
		| undefined,
	now: number,
): number | null => {
	if (!job) return null;
	if (job.status === "queued" || job.status === "running") return now;
	if (job.status !== "succeeded") return null;
	return job.finishedAt ?? job._creationTime;
};

export const collectorStarting = (state: {
	error: string;
	deployedAt: number | null;
	now: number;
}): boolean =>
	state.deployedAt !== null &&
	state.now - state.deployedAt < STARTING_WINDOW_MS &&
	NOT_ANSWERING.test(state.error);
