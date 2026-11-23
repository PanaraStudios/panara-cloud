import type { Claim } from "./handlers/types";

// What `agent.claimable` returns: the job claimNext would take now and the
// one claimNext({ quickOnly }) would take.
export type Claimable = { next: string | null; nextQuick: string | null };

type Unsubscribe = () => void;
type OnError = (error: unknown) => void;

// The backend as the loop sees it; index.ts backs it with the Convex client.
export type WorkSource = {
	claim: (quickOnly: boolean) => Promise<Claim | null>;
	watchClaimable: (
		onValue: (value: Claimable) => void,
		onError: OnError,
	) => Unsubscribe;
	watchCancels: (
		onValue: (jobIds: string[]) => void,
		onError: OnError,
	) => Unsubscribe;
	// `agent.hasQueuedJobs`, all a backend before 0.1.6 offers.
	watchQueued: (
		onValue: (hasJobs: boolean) => void,
		onError: OnError,
	) => Unsubscribe;
	// Called each time the WebSocket connects again after a loss.
	watchReconnects: (onReconnect: () => void) => Unsubscribe;
};

export type WorkLoopOptions = {
	maxParallelJobs: number;
	quickSlots: number;
	// Runs a claimed job to its end.
	run: (claim: Claim) => Promise<void>;
	// Asks a running job to stop; called again for a job already stopping.
	cancel: (jobId: string) => void;
	log: (message: string) => void;
};

// While the subscription works, a claim attempt this often catches anything
// it missed. Without it (a backend before 0.1.6, or the query failing) the
// loop polls as agents before 0.1.6 did.
export const SAFETY_POLL_MS = 3 * 60_000;
export const LEGACY_POLL_MS = 15_000;
export const CLAIM_RETRY_MS = 5_000;
// How often a failed subscription is tried again, e.g. for a backend whose
// functions were deployed after this agent started.
export const RESUBSCRIBE_MS = 5 * 60_000;

const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

// Claims jobs when the backend says there is work instead of asking every
// few seconds. Exactly-once claiming stays with claimNext (a mutation): the
// subscription only says when to call it, so a late, repeated or lost
// update can cost a claim attempt or delay one until the safety poll, never
// a double claim.
export class WorkLoop {
	private readonly regular = new Set<string>();
	private readonly quick = new Set<string>();
	private cancels = new Set<string>();
	private latest: Claimable | null = null;
	private subscribed = false;
	private stopped = true;
	private draining = false;
	private dirty = false;
	private forceNext = false;
	private pollTimer: ReturnType<typeof setTimeout> | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private resubscribeTimer: ReturnType<typeof setTimeout> | undefined;
	private unsubscribeWork: Unsubscribe[] = [];
	private unsubscribeQueued: Unsubscribe | null = null;
	private unsubscribeReconnects: Unsubscribe | null = null;

	constructor(
		private readonly source: WorkSource,
		private readonly options: WorkLoopOptions,
	) {}

	get mode(): "subscription" | "polling" {
		return this.subscribed ? "subscription" : "polling";
	}

	get runningCount(): number {
		return this.regular.size + this.quick.size;
	}

	start() {
		if (!this.stopped) return;
		this.stopped = false;
		this.subscribe();
		this.unsubscribeReconnects = this.source.watchReconnects(() =>
			this.wake(true),
		);
		this.schedulePoll();
		this.wake(true);
	}

	stop() {
		this.stopped = true;
		clearTimeout(this.pollTimer);
		clearTimeout(this.retryTimer);
		clearTimeout(this.resubscribeTimer);
		for (const unsubscribe of this.unsubscribeWork) unsubscribe();
		this.unsubscribeWork = [];
		this.unsubscribeQueued?.();
		this.unsubscribeQueued = null;
		this.unsubscribeReconnects?.();
		this.unsubscribeReconnects = null;
	}

	// `force` claims whatever the last update said: for polls, reconnects
	// and retries, which exist because that update may be missing or stale.
	wake(force = false) {
		if (this.stopped) return;
		this.dirty = true;
		this.forceNext ||= force;
		if (!this.draining) void this.drain();
	}

	private subscribe() {
		this.unsubscribeWork = [
			this.source.watchClaimable(
				(value) => this.onClaimable(value),
				(error) => this.onSubscriptionError(error),
			),
			this.source.watchCancels(
				(jobIds) => this.onCancels(jobIds),
				(error) =>
					this.options.log(
						`Cancel subscription failed (cancels arrive with heartbeats): ${errorMessage(error)}`,
					),
			),
		];
	}

	private onClaimable(value: Claimable) {
		if (this.stopped) return;
		this.latest = value;
		if (!this.subscribed) {
			this.subscribed = true;
			clearTimeout(this.resubscribeTimer);
			this.unsubscribeQueued?.();
			this.unsubscribeQueued = null;
			this.options.log("Waiting for jobs on a subscription");
			this.schedulePoll();
		}
		if (value.next !== null || value.nextQuick !== null) this.wake();
	}

	private onSubscriptionError(error: unknown) {
		if (this.stopped) return;
		const wasSubscribed = this.subscribed;
		this.subscribed = false;
		this.latest = null;
		if (wasSubscribed || !this.unsubscribeQueued) {
			this.options.log(
				`Job subscription failed, polling every ${LEGACY_POLL_MS / 1000}s: ${errorMessage(error)}`,
			);
		}
		this.unsubscribeQueued ??= this.source.watchQueued(
			(hasJobs) => {
				if (hasJobs) this.wake(true);
			},
			(queuedError) =>
				this.options.log(
					`Queue subscription failed: ${errorMessage(queuedError)}`,
				),
		);
		this.schedulePoll();
		clearTimeout(this.resubscribeTimer);
		this.resubscribeTimer = setTimeout(() => {
			if (this.stopped || this.subscribed) return;
			for (const unsubscribe of this.unsubscribeWork) unsubscribe();
			this.subscribe();
		}, RESUBSCRIBE_MS);
		this.wake(true);
	}

	private onCancels(jobIds: string[]) {
		this.cancels = new Set(jobIds);
		for (const jobId of jobIds) {
			if (this.regular.has(jobId) || this.quick.has(jobId)) {
				this.options.cancel(jobId);
			}
		}
	}

	private schedulePoll() {
		clearTimeout(this.pollTimer);
		if (this.stopped) return;
		this.pollTimer = setTimeout(
			() => {
				this.wake(true);
				this.schedulePoll();
			},
			this.subscribed ? SAFETY_POLL_MS : LEGACY_POLL_MS,
		);
	}

	private async drain() {
		this.draining = true;
		try {
			while (this.dirty && !this.stopped) {
				const force = this.forceNext || !this.subscribed;
				this.dirty = false;
				this.forceNext = false;
				await this.claimAll(force);
			}
		} catch (error) {
			this.options.log(`Claim failed: ${errorMessage(error)}`);
			clearTimeout(this.retryTimer);
			this.retryTimer = setTimeout(() => this.wake(true), CLAIM_RETRY_MS);
		} finally {
			this.draining = false;
		}
	}

	// Without `force`, claims only what the latest update says is there. A
	// claim's own write reaches the subscription before its result reaches
	// us (the Convex client orders them), so `latest` is current after each
	// claim; work that appears meanwhile sends an update that sets `dirty`.
	private async claimAll(force: boolean) {
		const { maxParallelJobs, quickSlots } = this.options;
		while (!this.stopped && this.regular.size < maxParallelJobs) {
			if (!force && this.latest?.next == null) break;
			const claim = await this.source.claim(false);
			// claimNext without quickOnly takes quick jobs too, so nothing at all
			// can start: the quick slots have nothing to ask for either.
			if (!claim) return;
			this.begin(claim, this.regular);
		}
		while (!this.stopped && this.quick.size < quickSlots) {
			if (!force && this.latest?.nextQuick == null) break;
			const claim = await this.source.claim(true);
			if (!claim) return;
			this.begin(claim, this.quick);
		}
	}

	private begin(claim: Claim, slots: Set<string>) {
		slots.add(claim.jobId);
		const done = this.options.run(claim);
		// A cancel that came in with or before the claim's own update.
		if (this.cancels.has(claim.jobId)) this.options.cancel(claim.jobId);
		void done
			.catch((error) =>
				this.options.log(
					`Job ${claim.jobId} ended badly: ${errorMessage(error)}`,
				),
			)
			.finally(() => {
				slots.delete(claim.jobId);
				this.wake();
			});
	}
}
