// A range of host metrics summarised by the collector: the readings from
// `from` to `to` (Unix seconds) in buckets of `step` seconds.
export type MetricsWindow = { from: number; to: number; step: number };

// The bounds the panel checks when a session opens
// (packages/backend/convex/live/lib.ts); a session asks for further windows
// itself, so the agent checks those.
const MAX_BUCKETS = 2000;
const MAX_WINDOW_SECONDS = 400 * 86_400;
const MAX_STEP_SECONDS = 30 * 86_400;

const WINDOW_KEYS = ["from", "to", "step"] as const;

export const hasMetricsWindow = (payload: Record<string, unknown>) =>
	WINDOW_KEYS.some((key) => payload[key] !== undefined);

export const parseMetricsWindow = (
	payload: Record<string, unknown>,
): MetricsWindow => {
	const { from, to, step } = payload;
	if (
		typeof from !== "number" ||
		typeof to !== "number" ||
		typeof step !== "number" ||
		!Number.isFinite(from) ||
		!Number.isFinite(to) ||
		from < 0 ||
		!(from < to) ||
		to - from > MAX_WINDOW_SECONDS
	) {
		throw new Error("The window must run from an earlier to a later time");
	}
	if (!Number.isInteger(step) || step < 1 || step > MAX_STEP_SECONDS) {
		throw new Error("The step must be a whole number of seconds");
	}
	if (Math.ceil((to - from) / step) > MAX_BUCKETS) {
		throw new Error(`A window holds at most ${MAX_BUCKETS} buckets`);
	}
	return { from, to, step };
};

// A collector that knows windows answers one object with `buckets`; an older
// one ignores the window and answers the array of readings `limit` asks for.
export const isBucketedAnswer = (data: unknown) =>
	typeof data === "object" &&
	data !== null &&
	Array.isArray((data as { buckets?: unknown }).buckets);
