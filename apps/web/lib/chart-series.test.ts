import assert from "node:assert/strict";
import { test } from "node:test";
import {
	bucketPoints,
	bucketSeries,
	bucketStep,
	medianInterval,
	niceCeiling,
	type Reading,
	rangeStep,
	rangeWindow,
	type SeriesBucket,
	timeTicks,
} from "./chart-series.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 22, 0, 0, 0);

const everyMinute = (count: number, value: (index: number) => number) =>
	Array.from({ length: count }, (_, index) => ({
		time: T0 + index * MINUTE,
		cpu: value(index),
	}));

test("median interval ignores outages and repeats", () => {
	assert.equal(medianInterval([]), 0);
	assert.equal(medianInterval([5]), 0);
	assert.equal(medianInterval([0, 60, 120, 180, 9000, 9060]), 60);
	assert.equal(medianInterval([0, 0, 10, 20]), 10);
});

test("readings that fit the plot are not bucketed", () => {
	// 1 h at one reading a minute in a 480 px plot: 8 px a point.
	assert.equal(
		bucketStep({ spanMs: HOUR, intervalMs: MINUTE, plotWidth: 480 }),
		0,
	);
	assert.equal(
		bucketStep({ spanMs: 0, intervalMs: MINUTE, plotWidth: 480 }),
		0,
	);
	assert.equal(bucketStep({ spanMs: HOUR, intervalMs: 0, plotWidth: 480 }), 0);
});

test("bucket size follows the plot width, on round steps", () => {
	const step = (spanMs: number, plotWidth: number, intervalMs = MINUTE) =>
		bucketStep({ spanMs, intervalMs, plotWidth });
	assert.equal(step(6 * HOUR, 480), 3 * MINUTE);
	assert.equal(step(DAY, 480), 12 * MINUTE);
	assert.equal(step(7 * DAY, 480), 2 * HOUR);
	assert.equal(step(30 * DAY, 480), 6 * HOUR);
	assert.equal(step(DAY, 720), 10 * MINUTE);
	assert.equal(step(7 * DAY, 720), HOUR);
	// Never fewer than 4 px a point.
	for (const width of [300, 480, 720, 1100]) {
		for (const span of [6 * HOUR, DAY, 7 * DAY, 30 * DAY]) {
			assert.ok(span / step(span, width) <= width / 4);
		}
	}
	// A bucket always holds more than one reading.
	assert.equal(step(HOUR, 200, 30_000), 2 * MINUTE);
	assert.equal(step(15 * MINUTE, 300, 10_000), 15_000);
});

test("a bucket carries the average, lowest and highest reading", () => {
	const readings = everyMinute(24, (index) => (index === 5 ? 99 : 10));
	const points = bucketSeries(readings, ["cpu"], { stepMs: 12 * MINUTE });
	assert.equal(points.length, 2);
	const [first, second] = points;
	assert.deepEqual(
		{ start: first?.start, end: first?.end, count: first?.count },
		{ start: T0, end: T0 + 12 * MINUTE, count: 12 },
	);
	assert.equal(first?.values.cpu?.max, 99);
	assert.equal(first?.values.cpu?.min, 10);
	assert.equal(first?.values.cpu?.avg, (11 * 10 + 99) / 12);
	assert.deepEqual(second?.values.cpu, { avg: 10, min: 10, max: 10 });
	assert.equal(first?.time, T0 + 6 * MINUTE);
});

test("buckets sit on the clock, so a new reading does not move them", () => {
	const offset = 7 * MINUTE + 20_000;
	const readings = Array.from({ length: 60 }, (_, index) => ({
		time: T0 + offset + index * MINUTE,
		cpu: index,
	}));
	const before = bucketSeries(readings.slice(0, 59), ["cpu"], {
		stepMs: 10 * MINUTE,
	});
	const after = bucketSeries(readings, ["cpu"], { stepMs: 10 * MINUTE });
	for (const point of after)
		assert.equal((point.start - T0) % (10 * MINUTE), 0);
	// Only the bucket still filling changes.
	assert.deepEqual(before.slice(0, -1), after.slice(0, before.length - 1));
	// The first bucket is cut by the start of the data: its point sits on
	// its readings.
	assert.ok((after[0]?.time ?? 0) >= T0 + offset);
});

test("hour and day buckets follow local time", () => {
	const utcOffsetMs = 5.5 * HOUR;
	const readings = Array.from({ length: 6 * 60 }, (_, index) => ({
		time: T0 + index * MINUTE,
		cpu: 1,
	}));
	const points = bucketSeries(readings, ["cpu"], { stepMs: HOUR, utcOffsetMs });
	for (const point of points) {
		assert.equal((point.start + utcOffsetMs) % HOUR, 0);
	}
	assert.equal(points[0]?.start, T0 - 30 * MINUTE);
});

test("an outage stays a gap", () => {
	const readings = everyMinute(360, () => 20).filter(
		(_, index) => index < 120 || index >= 240,
	);
	for (const stepMs of [0, 12 * MINUTE]) {
		const points = bucketSeries(readings, ["cpu"], { stepMs });
		const gaps = points.filter((point) => point.count === 0);
		assert.equal(gaps.length, 1);
		assert.equal(gaps[0]?.values.cpu, null);
		assert.equal(gaps[0]?.start, T0 + 119 * MINUTE);
		assert.equal(gaps[0]?.end, T0 + 240 * MINUTE);
		const at = points.indexOf(gaps[0] as (typeof points)[number]);
		assert.ok((points[at - 1]?.time ?? 0) <= T0 + 119 * MINUTE);
		assert.ok((points[at + 1]?.time ?? 0) >= T0 + 240 * MINUTE);
	}
});

test("a late reading is not an outage", () => {
	const readings = everyMinute(30, () => 5);
	(readings[10] as { time: number }).time += 50_000;
	const points = bucketSeries(readings, ["cpu"]);
	assert.equal(points.length, 30);
	assert.ok(points.every((point) => point.count === 1 && !point.alone));
});

test("a lone reading between two outages is marked", () => {
	const readings = [
		...everyMinute(10, () => 1),
		{ time: T0 + 60 * MINUTE, cpu: 7 },
		...everyMinute(10, () => 1).map((reading) => ({
			...reading,
			time: reading.time + 120 * MINUTE,
		})),
	];
	const points = bucketSeries(readings, ["cpu"]);
	assert.deepEqual(
		points.filter((point) => point.alone).map((point) => point.values.cpu?.avg),
		[7],
	);
	assert.equal(bucketSeries([{ time: T0, cpu: 1 }], ["cpu"])[0]?.alone, true);
});

test("series are bucketed apart and missing values are skipped", () => {
	const readings: Reading<"in" | "out">[] = [
		{ time: T0, in: null, out: undefined },
		{ time: T0 + MINUTE, in: 4, out: 1 },
		{ time: T0 + 2 * MINUTE, in: 0, out: Number.NaN },
		{ time: T0 + 10 * MINUTE, in: null, out: null },
	];
	const points = bucketSeries(readings, ["in", "out"], {
		stepMs: 10 * MINUTE,
		gapMs: HOUR,
	});
	assert.deepEqual(points[0]?.values, {
		in: { avg: 2, min: 0, max: 4 },
		out: { avg: 1, min: 1, max: 1 },
	});
	assert.deepEqual(points[1]?.values, { in: null, out: null });
	assert.equal(points[1]?.count, 1);
});

test("a month of readings becomes a screenful of points", () => {
	const readings = Array.from({ length: 30 * 24 * 60 }, (_, index) => ({
		time: T0 + index * MINUTE,
		cpu: index % 100,
	}));
	const stepMs = bucketStep({
		spanMs: 30 * DAY,
		intervalMs: medianInterval(readings.slice(0, 50).map((r) => r.time)),
		plotWidth: 480,
	});
	const points = bucketSeries(readings, ["cpu"], { stepMs });
	assert.equal(points.length, 120);
	assert.equal(
		points.reduce((sum, point) => sum + point.count, 0),
		43_200,
	);
});

test("ticks are round clock times inside the range", () => {
	const end = T0 + 12 * HOUR + 20 * MINUTE;
	const day = timeTicks(end - DAY, end, 6);
	assert.equal(day.stepMs, 4 * HOUR);
	assert.deepEqual(
		day.ticks.map((tick) => new Date(tick).toISOString().slice(11, 16)),
		["16:00", "20:00", "00:00", "04:00", "08:00", "12:00"],
	);
	const hour = timeTicks(end - HOUR, end, 6);
	assert.equal(hour.stepMs, 15 * MINUTE);
	assert.deepEqual(
		hour.ticks.map((tick) => new Date(tick).toISOString().slice(11, 16)),
		["11:30", "11:45", "12:00", "12:15"],
	);
	const week = timeTicks(end - 7 * DAY, end, 8);
	assert.equal(week.stepMs, DAY);
	assert.equal(week.ticks.length, 7);
	const month = timeTicks(end - 30 * DAY, end, 6);
	assert.equal(month.stepMs, 5 * DAY);
	for (const { ticks } of [day, hour, week, month]) {
		assert.ok(ticks.every((tick) => tick >= end - 30 * DAY && tick <= end));
	}
	assert.deepEqual(timeTicks(end, end, 6), { ticks: [], stepMs: 0 });
});

test("day ticks fall on local midnight", () => {
	const utcOffsetMs = 5.5 * HOUR;
	const end = T0 + 12 * HOUR;
	const { ticks } = timeTicks(end - 7 * DAY, end, 8, utcOffsetMs);
	for (const tick of ticks) assert.equal((tick + utcOffsetMs) % DAY, 0);
});

test("axis tops are round, with a round half", () => {
	assert.equal(niceCeiling(0), 0);
	assert.equal(niceCeiling(-3), 0);
	assert.equal(niceCeiling(0.07), 0.08);
	assert.equal(niceCeiling(0.3), 0.3);
	assert.equal(niceCeiling(4.2), 5);
	assert.equal(niceCeiling(5), 5);
	assert.equal(niceCeiling(86.7), 100);
	assert.equal(niceCeiling(101), 200);
	assert.equal(niceCeiling(1234), 2000);
});

test("kept readings stay a line when faster live ones outnumber them", () => {
	// Ten minutes kept every 10 s, then five minutes arriving every 2 s.
	const kept = Array.from({ length: 60 }, (_, i) => ({
		time: T0 + i * 10_000,
		cpu: 1,
	}));
	const live = Array.from({ length: 150 }, (_, i) => ({
		time: T0 + 600_000 + i * 2000,
		cpu: 1,
	}));
	const readings = [...kept, ...live];
	// By the usual pace alone (2 s) every kept reading is an outage apart.
	const byPace = bucketSeries(readings, ["cpu"]);
	assert.equal(byPace.filter((point) => point.count === 0).length, 60);
	assert.equal(byPace.filter((point) => point.alone).length, 60);
	// Told what an outage is, the whole stretch is one line.
	const told = bucketSeries(readings, ["cpu"], { gapMs: 30_000 });
	assert.equal(told.filter((point) => point.count === 0).length, 0);
	assert.equal(told.filter((point) => point.alone).length, 0);
	// A real outage is still one.
	const outage = bucketSeries(
		[...kept, ...live.map((r) => ({ ...r, time: r.time + 120_000 }))],
		["cpu"],
		{ gapMs: 30_000 },
	);
	assert.equal(outage.filter((point) => point.count === 0).length, 1);
});

test("a range summarised by the server is asked for in buckets the plot can show", () => {
	const minute = { intervalMs: MINUTE, plotWidth: 480 };
	// 30 days of minutes on a 480 px plot: 6-hour buckets, 120 of them.
	assert.equal(rangeStep({ spanMs: 30 * DAY, ...minute }), 6 * HOUR);
	assert.equal(rangeStep({ spanMs: 7 * DAY, ...minute }), 2 * HOUR);
	assert.equal(rangeStep({ spanMs: DAY, ...minute }), 12 * MINUTE);
	assert.equal(rangeStep({ spanMs: 6 * HOUR, ...minute }), 3 * MINUTE);
	// Where every reading fits, a bucket holds one reading.
	assert.equal(
		rangeStep({ spanMs: 6 * HOUR, intervalMs: MINUTE, plotWidth: 1600 }),
		MINUTE,
	);
	assert.equal(
		rangeStep({ spanMs: 6 * HOUR, intervalMs: 45_000, plotWidth: 4000 }),
		MINUTE,
	);
	// Nothing to size the buckets by yet.
	assert.equal(rangeStep({ spanMs: DAY, intervalMs: MINUTE, plotWidth: 0 }), 0);
	for (const days of [1, 7, 30]) {
		const step = rangeStep({ spanMs: days * DAY, ...minute });
		assert.ok((days * DAY) / step <= 120, `${days} d: ${step}`);
	}
});

test("a range starts on a bucket edge of the local clock and holds all of it", () => {
	const now = T0 + 13 * HOUR + 37 * MINUTE + 12_345;
	const utc = rangeWindow({ now, spanMs: DAY, stepMs: 15 * MINUTE });
	assert.equal(utc.to, now);
	assert.equal(utc.from, T0 - DAY + 13 * HOUR + 30 * MINUTE);
	assert.ok(now - utc.from >= DAY);
	// In India (UTC+5:30) two-hour buckets start on even local hours.
	const offset = 5.5 * HOUR;
	const local = rangeWindow({
		now,
		spanMs: 7 * DAY,
		stepMs: 2 * HOUR,
		utcOffsetMs: offset,
	});
	assert.equal((local.from + offset) % (2 * HOUR), 0);
	assert.ok(
		now - local.from >= 7 * DAY && now - local.from < 7 * DAY + 2 * HOUR,
	);
	// A minute later the range still starts on the same grid.
	const later = rangeWindow({
		now: now + MINUTE,
		spanMs: 7 * DAY,
		stepMs: 2 * HOUR,
		utcOffsetMs: offset,
	});
	assert.equal((later.from - local.from) % (2 * HOUR), 0);
});

test("buckets summarised elsewhere draw exactly as the readings behind them would", () => {
	// An hour of readings, an outage of two hours, then half an hour more.
	const readings = [
		...everyMinute(60, (index) => index % 7),
		...everyMinute(30, (index) => 50 + index).map((reading) => ({
			...reading,
			time: reading.time + 3 * HOUR,
		})),
	];
	const stepMs = 20 * MINUTE;
	const expected = bucketSeries(readings, ["cpu"], { stepMs });
	// What a server answers for the same range and step.
	const buckets: SeriesBucket<"cpu">[] = [];
	for (const reading of readings) {
		const start = Math.floor(reading.time / stepMs) * stepMs;
		let bucket = buckets.at(-1);
		if (bucket?.start !== start) {
			bucket = {
				start,
				first: reading.time,
				last: reading.time,
				count: 0,
				values: { cpu: { avg: 0, min: reading.cpu, max: reading.cpu } },
			};
			buckets.push(bucket);
		}
		const cpu = bucket.values.cpu;
		if (!cpu) continue;
		cpu.avg = (cpu.avg * bucket.count + reading.cpu) / (bucket.count + 1);
		cpu.min = Math.min(cpu.min, reading.cpu);
		cpu.max = Math.max(cpu.max, reading.cpu);
		bucket.last = reading.time;
		bucket.count++;
	}
	const drawn = bucketPoints(buckets, ["cpu"], { stepMs, gapMs: 3 * MINUTE });
	assert.equal(drawn.length, expected.length);
	drawn.forEach((point, index) => {
		const want = expected[index];
		assert.deepEqual(
			{ ...point, values: undefined },
			{ ...want, values: undefined },
		);
		assert.equal(point.values.cpu?.min, want?.values.cpu?.min);
		assert.equal(point.values.cpu?.max, want?.values.cpu?.max);
		assert.ok(
			Math.abs((point.values.cpu?.avg ?? 0) - (want?.values.cpu?.avg ?? 0)) <
				1e-9,
		);
	});
	assert.deepEqual(
		drawn.map((point) => point.count),
		[20, 20, 20, 0, 20, 10],
	);
});
