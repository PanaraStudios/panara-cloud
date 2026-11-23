// What became of a job after its user pressed Cancel. A cancel only stops
// work that is still going: a step that can't be interrupted (the service
// update that starts the new container) runs to its end, and then the job
// finished, whatever was asked for.

export type CancelOutcome = "pending" | "cancelled" | "tooLate" | "failed";

type JobState = { status: string };

/** `undefined` while the job loads; `null` for a job that is gone. */
export function cancelOutcome(job: JobState | null | undefined): CancelOutcome {
	if (job === undefined) return "pending";
	if (job === null) return "cancelled";
	switch (job.status) {
		case "queued":
		case "running":
			return "pending";
		case "succeeded":
			return "tooLate";
		case "failed":
			return "failed";
		default:
			return "cancelled";
	}
}

/** What the person who pressed Cancel is told when it came too late. */
export const TOO_LATE_TO_CANCEL = {
	title: "Too late to cancel",
	description:
		"It had already finished, so nothing was stopped and the result stands.",
} as const;

/** The same, on the page of a deployment (after "took 12s"). */
export const LATE_CANCEL_LABEL = "cancel arrived too late";
