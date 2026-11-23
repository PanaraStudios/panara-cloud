// A failure of work Docker already had when it failed: a Swarm service it was
// told to create or update, containers `docker compose up` was replacing. It
// is the work's own failure, not a cancel's, whatever was asked meanwhile.
export class FailedAfterHandoff extends Error {}

// Runs what is left once a change has been handed to Docker, which carries it
// out by itself: a cancel can no longer undo it, so `work` must not be given
// the job's signal. The job then ends as the change did: completed, and
// recorded with a cancel that came too late, or failed.
export const afterHandoff = async <T>(
	work: () => Promise<T>,
	options: { signal?: AbortSignal; onLateCancel: () => void },
): Promise<T> => {
	const { signal, onLateCancel } = options;
	if (signal?.aborted) onLateCancel();
	else signal?.addEventListener("abort", onLateCancel, { once: true });
	try {
		return await work();
	} catch (error) {
		throw new FailedAfterHandoff(
			error instanceof Error ? error.message : String(error),
			{ cause: error },
		);
	} finally {
		signal?.removeEventListener("abort", onLateCancel);
	}
};
