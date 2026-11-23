import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Claim } from "./handlers/types";
import {
	type Claimable,
	LEGACY_POLL_MS,
	RESUBSCRIBE_MS,
	SAFETY_POLL_MS,
	WorkLoop,
	type WorkSource,
} from "./workLoop";

type Listener<T> = {
	onValue: (value: T) => void;
	onError: (e: unknown) => void;
};

// A backend in memory: a queue the fake claimNext takes from, and the
// subscriptions WorkLoop opens, which tests push values and errors into.
const fakeBackend = (options: { hasClaimable?: boolean } = {}) => {
	const queue: { jobId: string; quick: boolean }[] = [];
	const claimable = new Set<Listener<Claimable>>();
	const cancels = new Set<Listener<string[]>>();
	const queued = new Set<Listener<boolean>>();
	const reconnects = new Set<() => void>();
	const calls = { claim: 0, claimQuick: 0 };
	let claimHook: (() => Promise<void>) | null = null;

	const value = (): Claimable => ({
		next: queue[0]?.jobId ?? null,
		nextQuick: queue.find((job) => job.quick)?.jobId ?? null,
	});
	const publish = () => {
		if (options.hasClaimable !== false) {
			for (const listener of claimable) listener.onValue(value());
		}
		for (const listener of queued) listener.onValue(queue.length > 0);
	};
	const watch =
		<T>(set: Set<Listener<T>>) =>
		(onValue: (value: T) => void, onError: (e: unknown) => void) => {
			const listener = { onValue, onError };
			set.add(listener);
			return () => set.delete(listener);
		};

	const source: WorkSource = {
		claim: async (quickOnly) => {
			if (quickOnly) calls.claimQuick++;
			else calls.claim++;
			await claimHook?.();
			const index = queue.findIndex((job) => !quickOnly || job.quick);
			if (index < 0) return null;
			const [job] = queue.splice(index, 1);
			if (!job) return null;
			// Like the Convex client: the claim's own update lands before its
			// result comes back.
			publish();
			return {
				jobId: job.jobId,
				leaseId: `lease-${job.jobId}`,
				attempt: 1,
			} as unknown as Claim;
		},
		watchClaimable: (onValue, onError) => {
			const unsubscribe = watch(claimable)(onValue, onError);
			queueMicrotask(() =>
				options.hasClaimable === false
					? onError(
							new Error("Could not find public function for 'agent:claimable'"),
						)
					: onValue(value()),
			);
			return unsubscribe;
		},
		watchCancels: watch(cancels),
		watchQueued: (onValue, onError) => {
			const unsubscribe = watch(queued)(onValue, onError);
			queueMicrotask(() => onValue(queue.length > 0));
			return unsubscribe;
		},
		watchReconnects: (onReconnect) => {
			reconnects.add(onReconnect);
			return () => reconnects.delete(onReconnect);
		},
	};

	return {
		source,
		calls,
		claimable,
		queued,
		enqueue: (jobId: string, quick = false, notify = true) => {
			queue.push({ jobId, quick });
			if (notify) publish();
		},
		cancel: (jobIds: string[]) => {
			for (const listener of cancels) listener.onValue(jobIds);
		},
		failClaimable: (error: Error) => {
			for (const listener of claimable) listener.onError(error);
		},
		publish,
		reconnect: () => {
			for (const onReconnect of reconnects) onReconnect();
		},
		setClaimHook: (hook: (() => Promise<void>) | null) => {
			claimHook = hook;
		},
		get queueLength() {
			return queue.length;
		},
	};
};

const harness = (
	backend: ReturnType<typeof fakeBackend>,
	limits = { maxParallelJobs: 2, quickSlots: 1 },
) => {
	const finishers = new Map<string, () => void>();
	const started: string[] = [];
	const cancelled: string[] = [];
	const logs: string[] = [];
	const loop = new WorkLoop(backend.source, {
		...limits,
		run: (claim) => {
			started.push(claim.jobId);
			return new Promise<void>((resolve) =>
				finishers.set(claim.jobId, resolve),
			);
		},
		cancel: (jobId) => cancelled.push(jobId),
		log: (message) => logs.push(message),
	});
	return {
		loop,
		started,
		cancelled,
		logs,
		finish: (jobId: string) => finishers.get(jobId)?.(),
	};
};

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("WorkLoop on a backend with the claimable query", () => {
	it("makes no claim at idle until the safety poll", async () => {
		const backend = fakeBackend();
		const { loop } = harness(backend);
		loop.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(loop.mode).toBe("subscription");
		// The first look at startup.
		expect(backend.calls).toEqual({ claim: 1, claimQuick: 0 });

		await vi.advanceTimersByTimeAsync(SAFETY_POLL_MS - 1);
		expect(backend.calls).toEqual({ claim: 1, claimQuick: 0 });
		await vi.advanceTimersByTimeAsync(1);
		expect(backend.calls).toEqual({ claim: 2, claimQuick: 0 });

		// An hour idle: one claim per safety poll, where polling every 15 s
		// with both claims made 480.
		await vi.advanceTimersByTimeAsync(60 * 60_000);
		expect(backend.calls.claim).toBe(2 + 20);
		expect(backend.calls.claimQuick).toBe(0);
		loop.stop();
	});

	it("claims as soon as work appears, up to its slots, and again when one frees", async () => {
		const backend = fakeBackend();
		const { loop, started, finish } = harness(backend);
		loop.start();
		await vi.advanceTimersByTimeAsync(0);

		backend.enqueue("a");
		backend.enqueue("b");
		backend.enqueue("c");
		await vi.advanceTimersByTimeAsync(0);
		expect(started).toEqual(["a", "b"]);
		expect(loop.runningCount).toBe(2);

		// A quick job takes the quick slot while the regular ones are busy.
		backend.enqueue("q", true);
		await vi.advanceTimersByTimeAsync(0);
		expect(started).toEqual(["a", "b", "q"]);

		finish("a");
		await vi.advanceTimersByTimeAsync(0);
		expect(started).toEqual(["a", "b", "q", "c"]);
		loop.stop();
	});

	it("does not ask for a quick job the update says isn't there", async () => {
		const backend = fakeBackend();
		const { loop, started } = harness(backend, {
			maxParallelJobs: 1,
			quickSlots: 2,
		});
		loop.start();
		await vi.advanceTimersByTimeAsync(0);
		backend.enqueue("a");
		backend.enqueue("b");
		await vi.advanceTimersByTimeAsync(0);
		expect(started).toEqual(["a"]);
		expect(backend.calls.claimQuick).toBe(0);
		loop.stop();
	});

	it("doesn't lose work that appears while a claim is in flight", async () => {
		const backend = fakeBackend();
		const { loop, started } = harness(backend, {
			maxParallelJobs: 4,
			quickSlots: 1,
		});
		loop.start();
		await vi.advanceTimersByTimeAsync(0);

		let release!: () => void;
		backend.setClaimHook(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		backend.enqueue("a");
		await vi.advanceTimersByTimeAsync(0);
		// The claim for a is out; b's update arrives meanwhile.
		backend.setClaimHook(null);
		backend.enqueue("b");
		release();
		await vi.advanceTimersByTimeAsync(0);
		expect(started).toEqual(["a", "b"]);
		loop.stop();
	});

	it("doesn't lose work whose update arrives while an empty claim returns", async () => {
		const backend = fakeBackend();
		const claim = backend.source.claim;
		let gate: Promise<void> | null = null;
		backend.source.claim = async (quickOnly) => {
			const result = await claim(quickOnly);
			await gate;
			return result;
		};
		const { loop, started } = harness(backend);
		loop.start();
		await vi.advanceTimersByTimeAsync(0);

		let open!: () => void;
		gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		loop.wake(true);
		await vi.advanceTimersByTimeAsync(0);
		// The claim found nothing; before its answer is back, a job comes.
		backend.enqueue("a");
		gate = null;
		open();
		await vi.advanceTimersByTimeAsync(0);
		expect(started).toEqual(["a"]);
		loop.stop();
	});

	it("claims after a reconnect even when the update is the same as before", async () => {
		const backend = fakeBackend();
		const { loop, started } = harness(backend);
		loop.start();
		await vi.advanceTimersByTimeAsync(0);
		// Work queued while the socket was down, its update never delivered.
		backend.enqueue("a", false, false);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(started).toEqual([]);
		backend.reconnect();
		await vi.advanceTimersByTimeAsync(0);
		expect(started).toEqual(["a"]);
		loop.stop();
	});

	it("a missed update is caught by the safety poll", async () => {
		const backend = fakeBackend();
		const { loop, started } = harness(backend);
		loop.start();
		await vi.advanceTimersByTimeAsync(0);
		backend.enqueue("a", false, false);
		await vi.advanceTimersByTimeAsync(SAFETY_POLL_MS);
		expect(started).toEqual(["a"]);
		loop.stop();
	});

	it("a claim that fails is retried", async () => {
		const backend = fakeBackend();
		const { loop, started, logs } = harness(backend);
		loop.start();
		await vi.advanceTimersByTimeAsync(0);
		backend.setClaimHook(async () => {
			throw new Error("Connection lost");
		});
		backend.enqueue("a");
		await vi.advanceTimersByTimeAsync(0);
		expect(logs.some((line) => line.includes("Connection lost"))).toBe(true);
		backend.setClaimHook(null);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(started).toEqual(["a"]);
		loop.stop();
	});

	it("passes a cancel on to the running job at once, and to one claimed with it", async () => {
		const backend = fakeBackend();
		const { loop, cancelled } = harness(backend);
		loop.start();
		await vi.advanceTimersByTimeAsync(0);
		backend.enqueue("a");
		await vi.advanceTimersByTimeAsync(0);
		backend.cancel(["a", "not-mine"]);
		expect(cancelled).toEqual(["a"]);

		// The cancel of b arrives before the claim of b returns.
		backend.setClaimHook(async () => backend.cancel(["a", "b"]));
		backend.enqueue("b");
		await vi.advanceTimersByTimeAsync(0);
		expect(cancelled).toEqual(["a", "a", "b"]);
		loop.stop();
	});

	it("stop ends claiming and the subscriptions", async () => {
		const backend = fakeBackend();
		const { loop, started } = harness(backend);
		loop.start();
		await vi.advanceTimersByTimeAsync(0);
		loop.stop();
		backend.enqueue("a");
		await vi.advanceTimersByTimeAsync(LEGACY_POLL_MS * 20);
		expect(started).toEqual([]);
		expect(backend.claimable.size).toBe(0);
	});
});

describe("WorkLoop on a backend without it", () => {
	it("polls every 15 s and claims on hasQueuedJobs, as before 0.1.6", async () => {
		const backend = fakeBackend({ hasClaimable: false });
		const { loop, started, logs } = harness(backend);
		loop.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(loop.mode).toBe("polling");
		expect(logs.some((line) => line.includes("polling every 15s"))).toBe(true);

		backend.enqueue("a");
		await vi.advanceTimersByTimeAsync(0);
		expect(started).toEqual(["a"]);

		const before = backend.calls.claim;
		await vi.advanceTimersByTimeAsync(LEGACY_POLL_MS);
		expect(backend.calls.claim).toBe(before + 1);
		loop.stop();
	});

	it("moves to the subscription once the backend has it", async () => {
		const options: { hasClaimable?: boolean } = { hasClaimable: false };
		const backend = fakeBackend(options);
		const { loop } = harness(backend);
		loop.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(loop.mode).toBe("polling");
		options.hasClaimable = true;
		await vi.advanceTimersByTimeAsync(RESUBSCRIBE_MS);
		expect(loop.mode).toBe("subscription");
		expect(backend.queued.size).toBe(0);
		const before = backend.calls.claim;
		await vi.advanceTimersByTimeAsync(SAFETY_POLL_MS - 1);
		expect(backend.calls.claim).toBe(before);
		loop.stop();
	});

	it("falls back to polling when a working subscription starts failing, and back", async () => {
		const backend = fakeBackend();
		const { loop } = harness(backend);
		loop.start();
		await vi.advanceTimersByTimeAsync(0);
		backend.failClaimable(new Error("Agent is not enrolled"));
		expect(loop.mode).toBe("polling");
		backend.publish();
		expect(loop.mode).toBe("subscription");
		loop.stop();
	});
});
