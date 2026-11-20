import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_DRAIN_SECONDS,
	drainRunningJobs,
	drainTimeoutMs,
	type RunningJob,
} from "./shutdown";

const job = (jobId: string, running: Map<string, RunningJob>) => {
	let finish!: () => void;
	const entry: RunningJob = {
		jobId,
		leaseId: `lease-${jobId}`,
		controller: new AbortController(),
		released: false,
		done: new Promise<void>((resolve) => {
			finish = () => {
				running.delete(jobId);
				resolve();
			};
		}),
	};
	running.set(jobId, entry);
	return { entry, finish };
};

describe("drainRunningJobs", () => {
	it("waits for running jobs and hands back nothing when they finish in time", async () => {
		vi.useFakeTimers();
		const running = new Map<string, RunningJob>();
		const a = job("a", running);
		const b = job("b", running);
		const release = vi.fn(async () => {});
		const drained = drainRunningJobs(running, {
			timeoutMs: 600_000,
			release,
			log: () => {},
		});
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		a.finish();
		await vi.advanceTimersByTimeAsync(4 * 60_000);
		b.finish();
		await expect(drained).resolves.toEqual({ released: [] });
		expect(release).not.toHaveBeenCalled();
		expect(a.entry.controller.signal.aborted).toBe(false);
		vi.useRealTimers();
	});

	it("hands back and aborts jobs still running at the deadline", async () => {
		vi.useFakeTimers();
		const running = new Map<string, RunningJob>();
		const fast = job("fast", running);
		const slow = job("slow", running);
		slow.entry.controller.signal.addEventListener("abort", () => slow.finish());
		const release = vi.fn(async (_job: RunningJob) => {});
		const drained = drainRunningJobs(running, {
			timeoutMs: 60_000,
			release,
			log: () => {},
		});
		await vi.advanceTimersByTimeAsync(1_000);
		fast.finish();
		await vi.advanceTimersByTimeAsync(60_000);
		await expect(drained).resolves.toEqual({ released: ["slow"] });
		expect(release).toHaveBeenCalledTimes(1);
		expect(release.mock.calls[0]?.[0]).toMatchObject({
			jobId: "slow",
			leaseId: "lease-slow",
			released: true,
		});
		expect(slow.entry.controller.signal.aborted).toBe(true);
		expect(fast.entry.released).toBe(false);
		vi.useRealTimers();
	});

	it("also waits for a job claimed after the signal", async () => {
		vi.useFakeTimers();
		const running = new Map<string, RunningJob>();
		const first = job("first", running);
		const release = vi.fn(async () => {});
		const drained = drainRunningJobs(running, {
			timeoutMs: 60_000,
			release,
			log: () => {},
		});
		const late = job("late", running);
		await vi.advanceTimersByTimeAsync(1_000);
		first.finish();
		await vi.advanceTimersByTimeAsync(10_000);
		late.finish();
		await expect(drained).resolves.toEqual({ released: [] });
		vi.useRealTimers();
	});

	it("does not hang when releasing or aborting stalls", async () => {
		vi.useFakeTimers();
		const running = new Map<string, RunningJob>();
		job("stuck", running);
		const logs: string[] = [];
		const drained = drainRunningJobs(running, {
			timeoutMs: 1_000,
			release: () => Promise.reject(new Error("offline")),
			log: (line) => logs.push(line),
			settleMs: 5_000,
		});
		await vi.advanceTimersByTimeAsync(20_000);
		await expect(drained).resolves.toEqual({ released: ["stuck"] });
		expect(logs.some((line) => line.includes("offline"))).toBe(true);
		vi.useRealTimers();
	});
});

describe("drainTimeoutMs", () => {
	it("defaults to ten minutes and accepts seconds", () => {
		expect(drainTimeoutMs(undefined)).toBe(DEFAULT_DRAIN_SECONDS * 1000);
		expect(drainTimeoutMs("")).toBe(600_000);
		expect(drainTimeoutMs("90")).toBe(90_000);
		expect(drainTimeoutMs("0")).toBe(0);
		expect(drainTimeoutMs("soon")).toBe(600_000);
	});
});
