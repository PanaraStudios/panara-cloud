import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	hasMetricsWindow,
	isBucketedAnswer,
	parseMetricsWindow,
} from "./metricsWindow";
import { metricsPath, metricsSession } from "./monitoring";
import type { ClientMessage, ServerMessage } from "./protocol";
import type { SessionContext } from "./session";

const DAY = 86_400;
const FROM = 1_790_000_000;
const WINDOW = { from: FROM, to: FROM + 30 * DAY, step: 7200 };

describe("the collector path", () => {
	test("a window asks for buckets and keeps the limit an old collector answers", () => {
		expect(metricsPath(10_000, null, WINDOW)).toBe(
			`/metrics?from=${FROM}&to=${FROM + 30 * DAY}&step=7200&limit=10000`,
		);
		expect(metricsPath(50, null)).toBe("/metrics?limit=50");
		// Container metrics have no buckets: a window changes nothing there.
		expect(metricsPath(10, "shop", WINDOW)).toBe(
			"/metrics/containers?limit=10&appName=shop",
		);
	});

	test("buckets are told from an old collector's readings by their shape", () => {
		expect(isBucketedAnswer({ from: 1, to: 2, step: 1, buckets: [] })).toBe(
			true,
		);
		expect(isBucketedAnswer([{ timestamp: "t", cpu: "1.00" }])).toBe(false);
		expect(isBucketedAnswer([])).toBe(false);
		expect(isBucketedAnswer(null)).toBe(false);
		expect(isBucketedAnswer({ error: "nope" })).toBe(false);
	});
});

describe("a window a session asks for", () => {
	test("is taken as given when it is within bounds", () => {
		expect(parseMetricsWindow({ ...WINDOW, extra: 1 })).toEqual(WINDOW);
		expect(
			parseMetricsWindow({ from: FROM + 0.25, to: FROM + 60, step: 60 }),
		).toEqual({ from: FROM + 0.25, to: FROM + 60, step: 60 });
		expect(hasMetricsWindow({})).toBe(false);
		expect(hasMetricsWindow({ from: FROM })).toBe(true);
	});

	test("is refused outside them", () => {
		const refused: [Record<string, unknown>, RegExp][] = [
			[{ from: FROM, to: FROM, step: 60 }, /earlier to a later/],
			[{ from: FROM + 1, to: FROM, step: 60 }, /earlier to a later/],
			[{ from: FROM, to: FROM + 401 * DAY, step: DAY }, /earlier to a later/],
			[{ from: "0", to: FROM, step: 60 }, /earlier to a later/],
			[{ to: FROM, step: 60 }, /earlier to a later/],
			[{ from: Number.NaN, to: FROM, step: 60 }, /earlier to a later/],
			[{ from: -5, to: FROM, step: 60 }, /earlier to a later/],
			[{ from: FROM, to: FROM + DAY, step: 0 }, /whole number/],
			[{ from: FROM, to: FROM + DAY, step: 1.5 }, /whole number/],
			[{ from: FROM, to: FROM + DAY }, /earlier to a later/],
			[{ from: FROM, to: FROM + 30 * DAY, step: 60 }, /at most 2000 buckets/],
		];
		for (const [payload, message] of refused) {
			expect(() => parseMetricsWindow(payload)).toThrow(message);
		}
	});
});

const BUCKETS = { from: FROM, to: FROM + DAY, step: 300, buckets: [] };
const READINGS = [{ timestamp: "2026-11-01T00:00:00Z", cpu: "1.00" }];

// A metrics session against a collector that answers `answer` for each path.
const session = (
	request: Record<string, unknown>,
	answer: (path: string) => unknown,
	appName: string | null = null,
) => {
	const sent: ServerMessage[] = [];
	const paths: string[] = [];
	const closed: string[] = [];
	const ctx = {
		redeemed: {
			extra: { type: "metrics", port: 4500, token: "t", appName },
			request: { kind: "metrics", dataPoints: 10_000, ...request },
		},
		send: (message: ServerMessage) => sent.push(message),
		close: (_code: number, reason: string) => closed.push(reason),
	} as unknown as SessionContext;
	const handler = metricsSession(ctx, async (path) => {
		paths.push(path);
		const value = answer(path);
		if (value instanceof Error) throw value;
		return value;
	});
	const refresh = (payload: Record<string, unknown> = {}) =>
		handler.onMessage?.({
			type: "request",
			id: "1",
			op: "refresh",
			payload,
		} as ClientMessage);
	return { sent, paths, closed, handler, refresh };
};

describe("a metrics session", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("with a window, the buckets are pushed once and never again unasked", async () => {
		const s = session({ window: WINDOW }, () => BUCKETS);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(s.paths).toEqual([metricsPath(10_000, null, WINDOW)]);
		expect(s.sent).toEqual([{ type: "metrics", data: BUCKETS }]);
		s.handler.dispose?.();
	});

	test("a refresh asks for the window it names: the newest buckets", async () => {
		const s = session({ window: WINDOW }, () => BUCKETS);
		await vi.advanceTimersByTimeAsync(0);
		const newest = { from: WINDOW.to - 7200, to: WINDOW.to + 60, step: 7200 };
		s.refresh(newest);
		await vi.advanceTimersByTimeAsync(0);
		expect(s.paths[1]).toBe(metricsPath(10_000, null, newest));
		expect(s.sent[1]).toEqual({
			type: "result",
			id: "1",
			ok: true,
			data: BUCKETS,
		});
		// Without one, the session's own window is read again.
		s.refresh();
		await vi.advanceTimersByTimeAsync(0);
		expect(s.paths[2]).toBe(metricsPath(10_000, null, WINDOW));
	});

	test("a refresh with a window out of bounds is refused before the collector is asked", async () => {
		const s = session({ window: WINDOW }, () => BUCKETS);
		await vi.advanceTimersByTimeAsync(0);
		s.refresh({ from: FROM, to: FROM + 365 * DAY, step: 1 });
		await vi.advanceTimersByTimeAsync(0);
		expect(s.paths).toHaveLength(1);
		expect(s.sent[1]).toMatchObject({
			type: "result",
			ok: false,
			error: expect.stringMatching(/at most 2000 buckets/),
		});
	});

	test("an old collector answers readings: they are pushed every 15 s as before", async () => {
		const s = session({ window: WINDOW }, () => READINGS);
		await vi.advanceTimersByTimeAsync(31_000);
		expect(s.paths).toHaveLength(3);
		expect(s.sent).toEqual([
			{ type: "metrics", data: READINGS },
			{ type: "metrics", data: READINGS },
			{ type: "metrics", data: READINGS },
		]);
		s.handler.dispose?.();
	});

	test("without a window nothing changes: readings every 15 s, refresh re-reads", async () => {
		const s = session({ dataPoints: 60 }, () => READINGS);
		await vi.advanceTimersByTimeAsync(16_000);
		expect(s.paths).toEqual(["/metrics?limit=60", "/metrics?limit=60"]);
		// A window sent to a session opened without one is not honoured.
		s.refresh(WINDOW);
		await vi.advanceTimersByTimeAsync(0);
		expect(s.paths[2]).toBe("/metrics?limit=60");
		s.handler.dispose?.();
	});

	test("a service's metrics ignore a window", async () => {
		const s = session({ window: WINDOW }, () => READINGS, "shop");
		await vi.advanceTimersByTimeAsync(0);
		expect(s.paths).toEqual(["/metrics/containers?limit=10000&appName=shop"]);
		s.handler.dispose?.();
	});

	test("three failures in a row close the session", async () => {
		const s = session({ window: WINDOW }, () => new Error("refused"));
		await vi.advanceTimersByTimeAsync(31_000);
		expect(s.closed).toEqual(["Monitoring is unreachable"]);
		expect(s.sent.filter((message) => message.type === "error")).toHaveLength(
			3,
		);
	});
});
