import assert from "node:assert/strict";
import { test } from "node:test";
import { bucketInterval, bucketPoints } from "./chart-series.ts";
import {
	type BucketedMetrics,
	busiestRate,
	cpuSummary,
	historyDiskMb,
	isBucketedMetrics,
	latestMetric,
	METRIC_KEYS,
	mergeBuckets,
	metricBuckets,
} from "./server-metrics.ts";

const T0 = Date.UTC(2026, 10, 1) / 1000;
const HOUR = 3600;

const stat = (avg: number, min = avg, max = avg) => ({ avg, min, max });

// One bucket per hour holding a reading a minute, as the collector answers.
const wire = (
	hour: number,
	cpu: { avg: number; min: number; max: number },
	extra: Partial<BucketedMetrics["buckets"][number]> = {},
): BucketedMetrics["buckets"][number] => ({
	start: T0 + hour * HOUR,
	first: T0 + hour * HOUR + 5,
	last: T0 + hour * HOUR + 59 * 60 + 5,
	count: 60,
	cpu,
	cpuMaxAt: T0 + hour * HOUR + 1800,
	memUsed: stat(50),
	diskUsed: stat(40),
	networkIn: stat(0.5, 0.1, 2),
	networkOut: stat(0.2, 0, 0.4),
	...extra,
});

const answer = (
	buckets: BucketedMetrics["buckets"],
	latest: BucketedMetrics["latest"] = null,
): BucketedMetrics => ({
	from: T0,
	to: T0 + 24 * HOUR,
	step: HOUR,
	buckets,
	latest,
});

test("buckets are told from an older service's readings, and from no answer", () => {
	assert.equal(isBucketedMetrics(answer([])), true);
	// What an agent or collector that predates ranges sends instead.
	assert.equal(isBucketedMetrics([{ timestamp: "t", cpu: "1.00" }]), false);
	assert.equal(isBucketedMetrics([]), false);
	assert.equal(isBucketedMetrics(null), false);
	assert.equal(isBucketedMetrics({ error: "Failed to fetch metrics" }), false);
	assert.equal(isBucketedMetrics({ buckets: [] }), false);
});

test("the collector's seconds become the charts' milliseconds and keys", () => {
	const [bucket] = metricBuckets(answer([wire(2, stat(40, 10, 90))]));
	assert.deepEqual(bucket, {
		start: (T0 + 2 * HOUR) * 1000,
		first: (T0 + 2 * HOUR + 5) * 1000,
		last: (T0 + 2 * HOUR + 59 * 60 + 5) * 1000,
		count: 60,
		cpuMaxAt: (T0 + 2 * HOUR + 1800) * 1000,
		values: {
			cpu: stat(40, 10, 90),
			memPercent: stat(50),
			diskPercent: stat(40),
			netIn: stat(0.5, 0.1, 2),
			netOut: stat(0.2, 0, 0.4),
		},
	});
});

test("a bucket without a rate has no network value, not a zero", () => {
	const [bucket] = metricBuckets(
		answer([wire(0, stat(5), { networkIn: null, networkOut: null })]),
	);
	assert.equal(bucket?.values.netIn, null);
	assert.equal(bucket?.values.netOut, null);
	assert.deepEqual(bucket?.values.cpu, stat(5));
});

test("average and peak are those of the readings behind the buckets", () => {
	const buckets = metricBuckets(
		answer([
			wire(0, stat(10, 5, 20)),
			// A short bucket: the average weighs each bucket by its readings.
			wire(1, stat(70, 60, 95), { count: 20, cpuMaxAt: T0 + HOUR + 600 }),
			wire(2, stat(30, 10, 95)),
		]),
	);
	const summary = cpuSummary(buckets);
	assert.equal(summary?.readings, 140);
	assert.equal(summary?.average, (10 * 60 + 70 * 20 + 30 * 60) / 140);
	assert.equal(summary?.peak, 95);
	// The first time the peak was reached.
	assert.equal(summary?.peakAt, (T0 + HOUR + 600) * 1000);
	assert.equal(cpuSummary([]), null);
	assert.equal(busiestRate(buckets), 2);
	assert.equal(busiestRate([]), 0);
});

test("the newest reading keeps its own values and rates", () => {
	const latest = latestMetric(
		answer([], {
			timestamp: "2026-11-01T12:00:00.25Z",
			cpu: 12.5,
			cpuCores: 4,
			memUsed: 50,
			memUsedGB: 8,
			memTotal: 16,
			diskUsed: 25,
			totalDisk: 200,
			networkIn: 1.5,
			networkOut: null,
		}),
	);
	assert.deepEqual(latest, {
		time: Date.UTC(2026, 10, 1, 12, 0, 0, 250),
		cpu: 12.5,
		cpuCores: 4,
		memPercent: 50,
		memGb: 8,
		memTotalGb: 16,
		diskPercent: 25,
		diskGb: 50,
		diskTotalGb: 200,
		netIn: 1.5,
		netOut: null,
	});
	assert.equal(latestMetric(answer([])), null);
});

test("a refresh replaces the newest bucket, adds the next and drops what left the range", () => {
	const held = metricBuckets(
		answer([
			wire(0, stat(1)),
			wire(1, stat(2)),
			wire(2, stat(3), { count: 30 }),
		]),
	);
	const fresh = metricBuckets(
		answer([wire(2, stat(4), { count: 60 }), wire(3, stat(5), { count: 2 })]),
	);
	const ms = (hour: number) => (T0 + hour * HOUR) * 1000;
	const merged = mergeBuckets(held, fresh, ms(2), ms(1));
	assert.deepEqual(
		merged.map((bucket) => [
			bucket.start,
			bucket.values.cpu?.avg,
			bucket.count,
		]),
		[
			[ms(1), 2, 60],
			[ms(2), 4, 60],
			[ms(3), 5, 2],
		],
	);
	// Nothing new: the held buckets before the refreshed edge stay as they are.
	assert.deepEqual(mergeBuckets(held, [], ms(3), ms(0)), held);
	// The first load of a range holds nothing yet.
	assert.deepEqual(mergeBuckets([], fresh, ms(0), ms(0)), fresh);
});

test("an outage between two buckets breaks the line; a quiet range draws none", () => {
	const buckets = metricBuckets(
		answer([wire(0, stat(10)), wire(1, stat(20)), wire(5, stat(30))]),
	);
	assert.equal(bucketInterval(buckets), 60_000);
	const points = bucketPoints(buckets, METRIC_KEYS, {
		stepMs: HOUR * 1000,
		gapMs: 3 * bucketInterval(buckets),
	});
	assert.deepEqual(
		points.map((point) => point.count),
		[60, 60, 0, 60],
	);
	const gap = points[2];
	assert.equal(gap?.values.cpu, null);
	assert.equal(gap?.start, (T0 + HOUR + 59 * 60 + 5) * 1000);
	assert.equal(gap?.end, (T0 + 5 * HOUR + 5) * 1000);
	// The bucket after the outage has no neighbour to draw a line to.
	assert.equal(points[3]?.alone, true);
	assert.equal(points[0]?.alone, false);
	assert.equal(points[0]?.end, (T0 + HOUR) * 1000);
	assert.deepEqual(bucketPoints([], METRIC_KEYS, { stepMs: 1, gapMs: 1 }), []);
});

test("the disk a history takes follows the days kept and the interval", () => {
	// Measured: 30 days of a reading a minute are a 12.2 MB file.
	assert.equal(Math.round(historyDiskMb(30, 60) * 10) / 10, 12.2);
	assert.equal(Math.round(historyDiskMb(2, 60) * 10) / 10, 0.8);
	assert.equal(Math.round(historyDiskMb(30, 2)), 365);
	assert.equal(historyDiskMb(0, 60), 0);
	assert.equal(historyDiskMb(30, 0), 0);
});
