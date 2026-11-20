export const DEFAULT_DRAIN_SECONDS = 600;

export const RESTART_REASON =
	"Agent restarted (update or service restart) before the job finished; run it again";

export const drainTimeoutMs = (value: string | undefined): number => {
	const seconds = Number(value?.trim() || DEFAULT_DRAIN_SECONDS);
	return Number.isFinite(seconds) && seconds >= 0
		? seconds * 1000
		: DEFAULT_DRAIN_SECONDS * 1000;
};

export type RunningJob = {
	jobId: string;
	leaseId: string;
	controller: AbortController;
	done: Promise<void>;
	// Set once the job was handed back, so its runner doesn't also report a
	// failure (the lease is gone by then).
	released: boolean;
};

const settle = (promises: Promise<unknown>[], ms: number) =>
	new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), ms);
		void Promise.allSettled(promises).then(() => {
			clearTimeout(timer);
			resolve(true);
		});
	});

// Lets running jobs finish within timeoutMs (their heartbeats keep the leases
// alive meanwhile), then hands back the rest: the backend requeues idempotent
// ones and fails the others with RESTART_REASON. The caller must have stopped
// claiming before this runs.
export const drainRunningJobs = async (
	running: ReadonlyMap<string, RunningJob>,
	{
		timeoutMs,
		release,
		log,
		settleMs = 10_000,
	}: {
		timeoutMs: number;
		release: (job: RunningJob) => Promise<unknown>;
		log: (message: string) => void;
		settleMs?: number;
	},
): Promise<{ released: string[] }> => {
	if (running.size > 0) {
		log(
			`Waiting up to ${Math.round(timeoutMs / 1000)}s for ${running.size} running job(s)`,
		);
		// Re-checks because a claim that was in flight when the signal came in
		// still starts.
		const deadline = Date.now() + timeoutMs;
		while (running.size > 0 && Date.now() < deadline) {
			await settle(
				[...running.values()].map((job) => job.done),
				deadline - Date.now(),
			);
		}
	}
	const left = [...running.values()];
	for (const job of left) {
		job.released = true;
		job.controller.abort();
	}
	await settle(
		left.map((job) =>
			release(job).catch((error) =>
				log(
					`Could not hand back ${job.jobId}: ${error instanceof Error ? error.message : String(error)}`,
				),
			),
		),
		settleMs,
	);
	// Give aborted handlers a moment to stop their child processes.
	await settle(
		left.map((job) => job.done),
		settleMs,
	);
	return { released: left.map((job) => job.jobId) };
};
