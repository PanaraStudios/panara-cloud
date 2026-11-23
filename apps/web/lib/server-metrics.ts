// A server's metrics as the collector summarises them for a range
// (`GET /metrics?from&to&step`, apps/monitoring), and what the Monitoring
// page reads from them. Times are Unix seconds on the wire and milliseconds
// here.
import type { SeriesBucket, Stat } from "./chart-series.ts";

type WireStat = { avg: number; min: number; max: number };

type WireBucket = {
	start: number;
	first: number;
	last: number;
	count: number;
	cpu: WireStat;
	cpuMaxAt: number;
	memUsed: WireStat;
	diskUsed: WireStat;
	networkIn: WireStat | null;
	networkOut: WireStat | null;
};

type WireLatest = {
	timestamp: string;
	cpu: number;
	cpuCores: number;
	memUsed: number;
	memUsedGB: number;
	memTotal: number;
	diskUsed: number;
	totalDisk: number;
	networkIn: number | null;
	networkOut: number | null;
};

export type BucketedMetrics = {
	from: number;
	to: number;
	step: number;
	buckets: WireBucket[];
	latest: WireLatest | null;
};

export type MetricKey =
	| "cpu"
	| "memPercent"
	| "diskPercent"
	| "netIn"
	| "netOut";

export const METRIC_KEYS: readonly MetricKey[] = [
	"cpu",
	"memPercent",
	"diskPercent",
	"netIn",
	"netOut",
];

export type MetricBucket = SeriesBucket<MetricKey> & {
	/** When the bucket's highest CPU reading was taken. */
	cpuMaxAt: number;
};

/** The newest reading the collector holds. */
export type LatestMetric = {
	time: number;
	cpu: number;
	cpuCores: number;
	memPercent: number;
	memGb: number;
	memTotalGb: number;
	diskPercent: number;
	diskGb: number;
	diskTotalGb: number;
	// MB/s; null for the only reading there is.
	netIn: number | null;
	netOut: number | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether an answer is the collector's buckets. An agent or collector that
 * predates them answers the array of readings it always has; anything else
 * is not an answer at all.
 */
export function isBucketedMetrics(data: unknown): data is BucketedMetrics {
	return (
		isRecord(data) &&
		Array.isArray(data.buckets) &&
		typeof data.step === "number" &&
		typeof data.from === "number" &&
		typeof data.to === "number"
	);
}

const stat = (value: WireStat | null | undefined): Stat | null =>
	value &&
	Number.isFinite(value.avg) &&
	Number.isFinite(value.min) &&
	Number.isFinite(value.max)
		? { avg: value.avg, min: value.min, max: value.max }
		: null;

/** The collector's buckets (oldest first) as the charts read them. */
export function metricBuckets(answer: BucketedMetrics): MetricBucket[] {
	return answer.buckets
		.filter((bucket) => bucket.count > 0 && Number.isFinite(bucket.start))
		.map((bucket) => ({
			start: bucket.start * 1000,
			first: bucket.first * 1000,
			last: bucket.last * 1000,
			count: bucket.count,
			cpuMaxAt: bucket.cpuMaxAt * 1000,
			values: {
				cpu: stat(bucket.cpu),
				memPercent: stat(bucket.memUsed),
				diskPercent: stat(bucket.diskUsed),
				netIn: stat(bucket.networkIn),
				netOut: stat(bucket.networkOut),
			},
		}));
}

export function latestMetric(answer: BucketedMetrics): LatestMetric | null {
	const { latest } = answer;
	const time = latest ? new Date(latest.timestamp).getTime() : Number.NaN;
	if (!latest || !Number.isFinite(time)) return null;
	return {
		time,
		cpu: latest.cpu,
		cpuCores: latest.cpuCores,
		memPercent: latest.memUsed,
		memGb: latest.memUsedGB,
		memTotalGb: latest.memTotal,
		diskPercent: latest.diskUsed,
		diskGb: (latest.totalDisk * latest.diskUsed) / 100,
		diskTotalGb: latest.totalDisk,
		netIn: latest.networkIn,
		netOut: latest.networkOut,
	};
}

/**
 * The buckets held for a range after a refresh: `fresh` (the answer to a
 * window starting at `freshFrom`, a bucket edge) replaces everything from
 * that edge on, and what now lies before `from` drops out.
 */
export function mergeBuckets(
	held: readonly MetricBucket[],
	fresh: readonly MetricBucket[],
	freshFrom: number,
	from: number,
): MetricBucket[] {
	return [
		...held.filter((bucket) => bucket.start < freshFrom),
		...fresh.filter((bucket) => bucket.start >= freshFrom),
	].filter((bucket) => bucket.start >= from);
}

/**
 * Average and peak CPU over the buckets: exactly what the readings behind
 * them give, since each bucket carries how many it holds, its highest
 * reading and when that was.
 */
export function cpuSummary(
	buckets: readonly MetricBucket[],
): { average: number; peak: number; peakAt: number; readings: number } | null {
	let sum = 0;
	let readings = 0;
	let peak = Number.NEGATIVE_INFINITY;
	let peakAt = 0;
	for (const bucket of buckets) {
		const cpu = bucket.values.cpu;
		if (!cpu) continue;
		sum += cpu.avg * bucket.count;
		readings += bucket.count;
		if (cpu.max > peak) {
			peak = cpu.max;
			peakAt = bucket.cpuMaxAt;
		}
	}
	return readings > 0
		? { average: sum / readings, peak, peakAt, readings }
		: null;
}

/** The highest network rate in the buckets, in MB/s. */
export function busiestRate(buckets: readonly MetricBucket[]): number {
	let top = 0;
	for (const bucket of buckets) {
		top = Math.max(
			top,
			bucket.values.netIn?.max ?? 0,
			bucket.values.netOut?.max ?? 0,
		);
	}
	return top;
}

// One reading of a server in the collector's SQLite file, index included:
// 43,200 readings (30 days of one a minute) measured 12.2 MB.
const BYTES_PER_READING = 282;

/**
 * Megabytes the server's own readings take on its disk when kept for `days`
 * at one every `refreshRate` seconds. Container readings come on top.
 */
export function historyDiskMb(days: number, refreshRate: number): number {
	if (!(days > 0) || !(refreshRate > 0)) return 0;
	return (days * (86_400 / refreshRate) * BYTES_PER_READING) / 1e6;
}
