/** One reading of a time series: a time and a number per series key. */
export type Reading<Key extends string> = { time: number } & {
	[K in Key]?: number | null;
};

export type Stat = { avg: number; min: number; max: number };

/** What a chart draws at one x position. */
export type ChartPoint<Key extends string> = {
	time: number;
	/** The span the point stands for; `start === end` for a single reading. */
	start: number;
	end: number;
	/** Readings behind the point. 0 is a gap: it breaks the line. */
	count: number;
	/** No reading on either side, so a line can't show it; draw a dot. */
	alone: boolean;
	values: { [K in Key]: Stat | null };
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Every step divides the next round unit of the clock, so bucket edges fall
// on times people read ("14:10", "midnight") and stay put between refreshes.
const BUCKET_STEPS = [
	...[1, 2, 5, 10, 15, 20, 30].map((n) => n * SECOND),
	...[1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30].map((n) => n * MINUTE),
	...[1, 2, 3, 4, 6, 8, 12].map((n) => n * HOUR),
	...[1, 2, 7].map((n) => n * DAY),
];

const TICK_STEPS = [
	...[1, 2, 5, 10, 15, 30].map((n) => n * MINUTE),
	...[1, 2, 3, 4, 6, 12].map((n) => n * HOUR),
	...[1, 2, 3, 5, 7, 14].map((n) => n * DAY),
];

/** The usual time between two readings; 0 with fewer than two. */
export function medianInterval(times: readonly number[]): number {
	const deltas: number[] = [];
	for (let i = 1; i < times.length; i++) {
		const delta = (times[i] ?? 0) - (times[i - 1] ?? 0);
		if (delta > 0) deltas.push(delta);
	}
	if (deltas.length === 0) return 0;
	deltas.sort((a, b) => a - b);
	return deltas[Math.floor(deltas.length / 2)] ?? 0;
}

/**
 * The bucket size that leaves at least `minPointPx` of plot per point, or 0
 * when the readings already fit and should be drawn as they are.
 */
export function bucketStep(input: {
	spanMs: number;
	intervalMs: number;
	plotWidth: number;
	minPointPx?: number;
}): number {
	const { spanMs, intervalMs, plotWidth, minPointPx = 4 } = input;
	if (!(spanMs > 0) || !(intervalMs > 0) || !(plotWidth > 0)) return 0;
	const maxPoints = Math.max(2, Math.floor(plotWidth / minPointPx));
	if (spanMs / intervalMs <= maxPoints) return 0;
	const needed = spanMs / maxPoints;
	return (
		BUCKET_STEPS.find((step) => step >= needed && step > intervalMs) ??
		Math.ceil(needed / DAY) * DAY
	);
}

/**
 * The step to ask a server for when it summarises a range itself: the one
 * `bucketStep` would draw, or, where every reading fits, the shortest step
 * that still holds a reading.
 */
export function rangeStep(input: {
	spanMs: number;
	intervalMs: number;
	plotWidth: number;
	minPointPx?: number;
}): number {
	if (
		!(input.spanMs > 0) ||
		!(input.intervalMs > 0) ||
		!(input.plotWidth > 0)
	) {
		return 0;
	}
	const step = bucketStep(input);
	if (step > 0) return step;
	return (
		BUCKET_STEPS.find((candidate) => candidate >= input.intervalMs) ??
		Math.ceil(input.intervalMs / DAY) * DAY
	);
}

/**
 * The range ending at `now` that holds `spanMs`, starting on a bucket edge
 * of the clock (`utcOffsetMs` puts the edges on local time), so the buckets
 * of a refresh line up with the ones already drawn.
 */
export function rangeWindow(input: {
	now: number;
	spanMs: number;
	stepMs: number;
	utcOffsetMs?: number;
}): { from: number; to: number } {
	const { now, spanMs, stepMs, utcOffsetMs = 0 } = input;
	const from =
		stepMs > 0
			? Math.floor((now - spanMs + utcOffsetMs) / stepMs) * stepMs - utcOffsetMs
			: now - spanMs;
	return { from, to: now };
}

/** Readings already summarised over `start` to `start + step`. */
export type SeriesBucket<Key extends string> = {
	start: number;
	/** The first and the last reading in the bucket. */
	first: number;
	last: number;
	count: number;
	values: { [K in Key]: Stat | null };
};

/**
 * Buckets (oldest first, none empty) as chart points. Wherever the readings
 * of two neighbours are further apart than `gapMs`, a point with `count: 0`
 * goes between them, so the line breaks instead of bridging the outage.
 */
export function bucketPoints<Key extends string>(
	buckets: readonly SeriesBucket<Key>[],
	keys: readonly Key[],
	options: { stepMs: number; gapMs: number },
): ChartPoint<Key>[] {
	const { stepMs, gapMs } = options;
	const points: ChartPoint<Key>[] = [];
	let previous: SeriesBucket<Key> | undefined;
	for (const bucket of buckets) {
		if (bucket.count <= 0) continue;
		if (previous && gapMs > 0 && bucket.first - previous.last > gapMs) {
			points.push({
				time: (previous.last + bucket.first) / 2,
				start: previous.last,
				end: bucket.first,
				count: 0,
				alone: false,
				values: Object.fromEntries(
					keys.map((key) => [key, null]),
				) as ChartPoint<Key>["values"],
			});
		}
		const middle = bucket.start + stepMs / 2;
		points.push({
			// A bucket cut short by the edge of the data or by an outage sits
			// where its readings are, not in the empty part.
			time: Math.min(bucket.last, Math.max(bucket.first, middle)),
			start: bucket.start,
			end: bucket.start + Math.max(0, stepMs),
			count: bucket.count,
			alone: false,
			values: bucket.values,
		});
		previous = bucket;
	}
	points.forEach((point, index) => {
		if (point.count === 0) return;
		const before = points[index - 1];
		const after = points[index + 1];
		point.alone =
			(!before || before.count === 0) && (!after || after.count === 0);
	});
	return points;
}

/**
 * The usual time between two readings of buckets that came summarised, from
 * the ones holding more than one; 0 when none does.
 */
export function bucketInterval<Key extends string>(
	buckets: readonly SeriesBucket<Key>[],
): number {
	const intervals = buckets
		.filter((bucket) => bucket.count > 1 && bucket.last > bucket.first)
		.map((bucket) => (bucket.last - bucket.first) / (bucket.count - 1))
		.sort((a, b) => a - b);
	return intervals[Math.floor(intervals.length / 2)] ?? 0;
}

type Open<Key extends string> = {
	start: number;
	first: number;
	last: number;
	count: number;
	sums: Record<Key, number>;
	counts: Record<Key, number>;
	mins: Record<Key, number>;
	maxs: Record<Key, number>;
};

/**
 * Readings (oldest first) as chart points. With a `stepMs` they are grouped
 * into buckets on the clock (`utcOffsetMs` shifts the edges to local time),
 * each with its average, lowest and highest value; without, every reading is
 * its own point. Wherever readings stop for longer than `gapMs` a point with
 * `count: 0` is added, so the line breaks instead of bridging the outage.
 */
export function bucketSeries<Key extends string>(
	readings: readonly Reading<Key>[],
	keys: readonly Key[],
	options: { stepMs?: number; gapMs?: number; utcOffsetMs?: number } = {},
): ChartPoint<Key>[] {
	const { stepMs = 0, utcOffsetMs = 0 } = options;
	const gapMs =
		options.gapMs ??
		3 * medianInterval(readings.map((reading) => reading.time));
	const empty = () =>
		Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;

	const groups: Open<Key>[] = [];
	let open: Open<Key> | undefined;
	for (const reading of readings) {
		const { time } = reading;
		if (!Number.isFinite(time)) continue;
		const start =
			stepMs > 0
				? Math.floor((time + utcOffsetMs) / stepMs) * stepMs - utcOffsetMs
				: time;
		if (!open || stepMs <= 0 || start !== open.start) {
			open = {
				start,
				first: time,
				last: time,
				count: 0,
				sums: empty(),
				counts: empty(),
				mins: empty(),
				maxs: empty(),
			};
			groups.push(open);
		}
		open.last = time;
		open.count++;
		for (const key of keys) {
			const value = reading[key];
			if (typeof value !== "number" || !Number.isFinite(value)) continue;
			const seen = open.counts[key];
			open.sums[key] += value;
			open.mins[key] = seen ? Math.min(open.mins[key], value) : value;
			open.maxs[key] = seen ? Math.max(open.maxs[key], value) : value;
			open.counts[key] = seen + 1;
		}
	}

	return bucketPoints(
		groups.map((group) => ({
			start: group.start,
			first: group.first,
			last: group.last,
			count: group.count,
			values: Object.fromEntries(
				keys.map((key) => [
					key,
					group.counts[key]
						? {
								avg: group.sums[key] / group.counts[key],
								min: group.mins[key],
								max: group.maxs[key],
							}
						: null,
				]),
			) as ChartPoint<Key>["values"],
		})),
		keys,
		{ stepMs, gapMs },
	);
}

/**
 * Round clock times between `start` and `end` for axis ticks, at most
 * `maxTicks` of them. `utcOffsetMs` puts hour and day steps on local time.
 */
export function timeTicks(
	start: number,
	end: number,
	maxTicks: number,
	utcOffsetMs = 0,
): { ticks: number[]; stepMs: number } {
	const span = end - start;
	if (!(span > 0) || maxTicks < 1) return { ticks: [], stepMs: 0 };
	const countAt = (step: number) =>
		Math.floor((end + utcOffsetMs) / step) -
		Math.ceil((start + utcOffsetMs) / step) +
		1;
	const stepMs =
		TICK_STEPS.find((step) => countAt(step) <= maxTicks) ??
		Math.ceil(span / maxTicks / (14 * DAY)) * 14 * DAY;
	const ticks: number[] = [];
	for (
		let tick = Math.ceil((start + utcOffsetMs) / stepMs) * stepMs - utcOffsetMs;
		tick <= end;
		tick += stepMs
	) {
		ticks.push(tick);
	}
	return { ticks, stepMs };
}

const NICE = [1, 2, 3, 4, 5, 6, 8, 10];

/** The next round number at or above `value`, whose half is round too. */
export function niceCeiling(value: number): number {
	if (!(value > 0) || !Number.isFinite(value)) return 0;
	const magnitude = 10 ** Math.floor(Math.log10(value));
	const scaled = value / magnitude;
	// Guards 2.9999999999 turning into 3 and 3.0000000001 into 4.
	const step = NICE.find((nice) => nice >= scaled - 1e-9) ?? 10;
	return Number((step * magnitude).toPrecision(12));
}
