"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import { format } from "date-fns";
import {
	ArrowUpDownIcon,
	BellIcon,
	ChartColumnIcon,
	CpuIcon,
	GaugeIcon,
	HardDriveIcon,
	Loader2,
	type LucideIcon,
	MemoryStickIcon,
	SlidersHorizontalIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ContainerFreeMonitoring } from "@/components/dashboard/monitoring/free/container/show-free-container-monitoring";
import { HOST_APP_NAME } from "@/components/dashboard/monitoring/live-stats";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	chartPlotWidth,
	MetricChart,
	MetricLegend,
	type MetricSeries,
} from "@/components/ui/metric-chart";
import { Switch } from "@/components/ui/switch";
import {
	ConfirmDialog,
	EmptyState,
	Section,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import {
	bucketInterval,
	bucketPoints,
	type ChartPoint,
} from "@/lib/chart-series";
import { useQueryResult } from "@/lib/host-data";
import {
	collectorStarting,
	METRICS_RETRY_MS,
	monitoringDeployedAt,
} from "@/lib/monitoring-start";
import { serverUrl } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import {
	busiestRate,
	cpuSummary,
	type LatestMetric,
	METRIC_KEYS,
	type MetricBucket,
	type MetricKey,
} from "@/lib/server-metrics";
import {
	type MonitoringConfig,
	MonitoringDeployStatus,
	type MonitoringSettings,
	useMonitoringConfig,
	useSaveMonitoring,
} from "./monitoring-setup";
import { FilterPills, FootNote, ListSkeleton, LoadFailed } from "./server-ui";
import { useServerRef } from "./use-server";
import { MAX_READINGS, useServerMetrics } from "./use-server-metrics";

type Config = MonitoringConfig;
type Settings = MonitoringSettings;

// From 6 h on the monitoring service summarises the range in buckets; an
// hour is few enough readings to load as they are.
const RANGES = [
	{ value: "1h", label: "1h", seconds: 3600, bucketed: false },
	{ value: "6h", label: "6h", seconds: 6 * 3600, bucketed: true },
	{ value: "24h", label: "24h", seconds: 24 * 3600, bucketed: true },
	{ value: "7d", label: "7d", seconds: 7 * 86400, bucketed: true },
	{ value: "30d", label: "30d", seconds: 30 * 86400, bucketed: true },
] as const;
type Range = (typeof RANGES)[number]["value"];

export type RawMetric = {
	timestamp: string;
	cpu: string;
	cpuCores?: number;
	memUsed: string;
	memUsedGB: string;
	memTotal: string;
	diskUsed: string;
	totalDisk: string;
	networkIn: string;
	networkOut: string;
};

type Point = {
	time: number;
	cpu: number;
	memPercent: number;
	memGb: number;
	diskPercent: number;
	diskGb: number;
	// No rate for the first reading: there is nothing to take it from.
	netIn: number | null;
	netOut: number | null;
};

const num = (value: string | number | undefined) => {
	const parsed =
		typeof value === "number" ? value : Number.parseFloat(value ?? "");
	return Number.isFinite(parsed) ? parsed : 0;
};

// The monitoring container reports network counters as MB since boot; the
// charts show the rate between two readings.
function toPoints(raw: RawMetric[]): Point[] {
	return raw.map((metric, index) => {
		const time = new Date(metric.timestamp).getTime();
		const previous = raw[index - 1];
		const seconds = previous
			? (time - new Date(previous.timestamp).getTime()) / 1000
			: 0;
		const rate = (now: string, before: string | undefined) =>
			previous && seconds > 0
				? Math.max(0, (num(now) - num(before)) / seconds)
				: null;
		const diskPercent = num(metric.diskUsed);
		return {
			time,
			cpu: num(metric.cpu),
			memPercent: num(metric.memUsed),
			memGb: num(metric.memUsedGB),
			diskPercent,
			diskGb: (num(metric.totalDisk) * diskPercent) / 100,
			netIn: rate(metric.networkIn, previous?.networkIn),
			netOut: rate(metric.networkOut, previous?.networkOut),
		};
	});
}

const formatGb = (value: number) =>
	value >= 100 ? value.toFixed(0) : value.toFixed(1);

const formatRate = (mbPerSecond: number) =>
	mbPerSecond >= 1
		? `${mbPerSecond.toFixed(1)} MB/s`
		: `${(mbPerSecond * 1024).toFixed(0)} KB/s`;

const formatPercent = (value: number) => `${value.toFixed(0)}%`;

const SYNC_ID = "server-metrics";
// "100 MB/s": the four plots start at the same place.
const TICK_CHARS = 8;

export function ServerMonitoringPage() {
	const ref = useServerRef();
	const permissions = usePermissions();
	const canView = permissions.monitoring.read && permissions.docker.read;
	const { loading, config } = useMonitoringConfig(ref.serverId, canView);
	const [range, setRange] = useState<Range>("24h");

	if (!canView) {
		return (
			<EmptyState
				icon={ChartColumnIcon}
				title="Not available"
				description="Your role doesn't include this part of the server."
			/>
		);
	}

	const refreshRate = config?.settings.refreshRate ?? 60;
	const retentionDays = config?.settings.retentionDays ?? 2;
	const enabled = !!config?.enabled;
	// The panel host shows live usage without the monitoring service.
	const liveOnly = ref.isLocal && !!config && !config.configured;

	return (
		<div className="flex w-full flex-col gap-6 pb-10">
			<div className="flex min-h-9 flex-wrap items-center justify-end gap-2 empty:hidden">
				{enabled ? (
					<>
						<span className="mr-auto text-muted-foreground text-sm">
							A reading every {refreshRate} s
						</span>
						<FilterPills
							value={range}
							onValueChange={setRange}
							options={RANGES.map((option) => {
								const kept = option.seconds <= retentionDays * 86400;
								return {
									value: option.value,
									label: option.label,
									disabled: !kept,
									title: kept
										? undefined
										: `History is kept for ${retentionDays} ${retentionDays === 1 ? "day" : "days"}: raise "Keep history" in Monitoring settings to see ${option.label}`,
								};
							})}
						/>
					</>
				) : config ? (
					<>
						{liveOnly ? (
							<FootNote className="mr-auto min-w-0 flex-1 basis-80">
								History and alerts need the monitoring service; set it up to
								keep CPU, memory, disk and network readings for this server.
							</FootNote>
						) : null}
						<MonitoringOffActions serverId={ref.serverId} config={config} />
					</>
				) : null}
			</div>
			{loading ? (
				<ListSkeleton rows={4} />
			) : enabled && config ? (
				<>
					<MonitoringDeployStatus jobId={config.lastJobId} />
					<MetricCharts
						serverId={ref.serverId}
						range={range}
						settings={config.settings}
						deployJobId={config.lastJobId}
					/>
					<AlertsSection serverId={ref.serverId} config={config} />
				</>
			) : (
				<>
					{liveOnly ? null : <MonitoringOff config={config} />}
					{config?.lastJobId ? (
						<MonitoringDeployStatus jobId={config.lastJobId} />
					) : null}
					{ref.isLocal ? (
						<Section
							title="Live usage"
							icon={GaugeIcon}
							hint="Right now; nothing is kept"
						>
							<div className="pt-4">
								<ContainerFreeMonitoring appName={HOST_APP_NAME} embedded />
							</div>
						</Section>
					) : null}
				</>
			)}
		</div>
	);
}

/** The page's one primary action while monitoring isn't running. */
function MonitoringOffActions({
	serverId,
	config,
}: {
	serverId: string | undefined;
	config: Config;
}) {
	const ref = useServerRef();
	const save = useSaveMonitoring(serverId);
	const [pending, setPending] = useState(false);
	const settingsUrl = serverUrl(ref.routeId, "monitoring/settings");
	if (!config.configured) {
		return (
			<Button nativeButton={false} render={<Link href={settingsUrl} />}>
				Set up monitoring
			</Button>
		);
	}
	return (
		<>
			<Button
				variant="outline"
				nativeButton={false}
				render={<Link href={settingsUrl} />}
			>
				Settings
			</Button>
			<Button
				isLoading={pending}
				onClick={async () => {
					setPending(true);
					try {
						await save(config.settings, { deploy: true });
						toast.success("Monitoring is starting on the server");
					} catch (error) {
						toast.error(errorMessage(error));
					} finally {
						setPending(false);
					}
				}}
			>
				Turn on monitoring
			</Button>
		</>
	);
}

function MonitoringOff({ config }: { config: Config | null | undefined }) {
	if (!config) {
		return (
			<EmptyState
				icon={ChartColumnIcon}
				title="Monitoring isn't set up"
				description="An administrator of this server can set it up to keep CPU, memory, disk and network history and send alerts."
			/>
		);
	}
	if (!config.configured) {
		return (
			<EmptyState
				icon={ChartColumnIcon}
				title="Monitoring isn't set up"
				description="Deploy a small monitoring service to keep CPU, memory, disk and network history for this server and get alerts when it runs hot."
			/>
		);
	}
	return (
		<EmptyState
			icon={ChartColumnIcon}
			title="Monitoring is off"
			description={`Turning it on deploys the monitoring service again with its saved settings: every ${config.settings.refreshRate} s, kept ${config.settings.retentionDays} ${config.settings.retentionDays === 1 ? "day" : "days"}.`}
		/>
	);
}

/** The plot width of one chart panel, known before any chart is drawn. */
function usePanelPlotWidth() {
	const ref = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		setWidth(element.clientWidth);
		const observer = new ResizeObserver(([entry]) => {
			if (entry) setWidth(Math.round(entry.contentRect.width));
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return [ref, chartPlotWidth(width, TICK_CHARS)] as const;
}

type MetricChartsProps = {
	serverId: string | undefined;
	range: Range;
	settings: Settings;
	/** The job that last set monitoring up, to tell "starting" from "failed". */
	deployJobId: Id<"jobs"> | null;
};

/** The charts, read again every few seconds while the read fails: right
    after a set-up the collector is not up yet, and a closed live session
    does not come back by itself. */
function MetricCharts(props: MetricChartsProps) {
	const [attempt, setAttempt] = useState(0);
	const [failure, setFailure] = useState<string | null>(null);
	const retry = useCallback(() => setAttempt((value) => value + 1), []);
	return (
		<MetricChartsAttempt
			key={attempt}
			{...props}
			failure={failure}
			onFailure={setFailure}
			onRetry={retry}
		/>
	);
}

function MetricChartsAttempt({
	serverId,
	range,
	settings,
	deployJobId,
	failure,
	onFailure,
	onRetry,
}: MetricChartsProps & {
	/** What the attempt before this one failed with. */
	failure: string | null;
	onFailure: (error: string | null) => void;
	onRetry: () => void;
}) {
	const { active } = useOrganization();
	const job = useQueryResult(
		api.jobs.get,
		deployJobId ? { jobId: deployJobId } : "skip",
	);
	const chosen = RANGES.find((item) => item.value === range) ?? RANGES[2];
	const { seconds } = chosen;
	const [sizer, plotWidth] = usePanelPlotWidth();
	const { metrics, isLoading, error } = useServerMetrics(
		{
			type: "host",
			organizationId: active.id,
			serverId: serverId as Id<"servers"> | undefined,
		},
		{
			seconds,
			refreshRate: settings.refreshRate,
			bucketed: chosen.bucketed,
			plotWidth,
		},
	);
	const wanted = Math.ceil(seconds / settings.refreshRate);
	const shownDays = (MAX_READINGS * settings.refreshRate) / 86400;
	const loaded = metrics !== undefined;
	useEffect(() => {
		if (loaded) {
			onFailure(null);
			return;
		}
		if (!error) return;
		onFailure(error);
		const timer = setTimeout(onRetry, METRICS_RETRY_MS);
		return () => clearTimeout(timer);
	}, [loaded, error, onFailure, onRetry]);
	// While the next attempt connects, the last failure stays on screen.
	const shownError = error ?? (isLoading ? failure : null);
	const starting =
		shownError !== null &&
		collectorStarting({
			error: shownError,
			deployedAt: monitoringDeployedAt(
				job instanceof Error ? null : job,
				Date.now(),
			),
			now: Date.now(),
		});
	return (
		<div className="relative flex flex-col gap-6">
			{/* One cell of the charts' grid, laid out like a panel: its width is
			    a chart's, so the buckets asked for fit the plot. */}
			<div
				aria-hidden="true"
				className="pointer-events-none invisible absolute inset-x-0 top-0 grid h-0 gap-4 lg:grid-cols-2"
			>
				<div className="min-w-0 border-x px-4">
					<div ref={sizer} />
				</div>
			</div>
			{starting ? (
				<NoReadings
					settings={settings}
					title="Monitoring is starting"
					description="The monitoring service was just set up and does not answer yet. This page tries again every few seconds."
				/>
			) : shownError ? (
				<LoadFailed
					icon={ChartColumnIcon}
					what="metrics"
					error={shownError}
					onRetry={onRetry}
				/>
			) : isLoading ? (
				<ListSkeleton rows={4} />
			) : !metrics ? (
				<LoadFailed
					icon={ChartColumnIcon}
					what="metrics"
					error="The monitoring service did not answer"
				/>
			) : metrics.mode === "buckets" ? (
				<BucketChartsView
					buckets={metrics.buckets}
					latest={metrics.latest}
					stepMs={metrics.stepMs}
					domain={[metrics.from, metrics.to]}
					range={range}
					settings={settings}
				/>
			) : (
				<>
					<MetricChartsView
						raw={metrics.readings as RawMetric[]}
						range={range}
						settings={settings}
						complete={wanted <= MAX_READINGS}
					/>
					{wanted > MAX_READINGS ? (
						<FootNote>
							At a reading every {settings.refreshRate} s this range holds more
							readings than the panel loads at once from a monitoring service of
							an earlier release: the charts show the last{" "}
							{shownDays >= 2
								? `${Math.floor(shownDays)} days`
								: `${Math.floor(shownDays * 24)} hours`}
							. The service is updated the next time the panel works on this
							server.
						</FootNote>
					) : null}
				</>
			)}
		</div>
	);
}

function NoReadings({
	settings,
	title = "No readings yet",
	description,
}: {
	settings: Pick<Settings, "refreshRate">;
	title?: string;
	description?: string;
}) {
	return (
		<EmptyState
			icon={ChartColumnIcon}
			title={title}
			description={
				description ??
				`The monitoring service reports every ${settings.refreshRate} s; the first readings show up here shortly.`
			}
		/>
	);
}

/** The four charts of a server, from the collector's readings (oldest first). */
export function MetricChartsView({
	raw,
	range,
	settings,
	complete = false,
}: {
	raw: RawMetric[];
	range: Range;
	settings: Pick<Settings, "refreshRate" | "thresholds">;
	/** The readings are all there are in the range, not the last so many. */
	complete?: boolean;
}) {
	const seconds = RANGES.find((item) => item.value === range)?.seconds ?? 86400;
	const series = useMemo(() => {
		const points = toPoints(raw);
		// The collector returns the last N readings, which reach further back
		// than the range when the server was off for part of it.
		const from = (points[points.length - 1]?.time ?? 0) - seconds * 1000;
		return points.filter((point) => point.time >= from);
	}, [raw, seconds]);
	const latest = series[series.length - 1];
	const last = raw[raw.length - 1];
	if (!latest || !last) return <NoReadings settings={settings} />;
	const peak = series.reduce((top, point) =>
		point.cpu > top.cpu ? point : top,
	);
	const totalDisk = num(last.totalDisk);
	return (
		<MetricPanels
			chart={{ readings: series }}
			// A range only partly filled (monitoring is younger than it) keeps
			// its full width; the part without readings stays empty.
			domain={
				complete ? [latest.time - seconds * 1000, latest.time] : undefined
			}
			latest={{
				time: latest.time,
				cpu: latest.cpu,
				cpuCores: last.cpuCores ?? 0,
				memPercent: latest.memPercent,
				memGb: latest.memGb,
				memTotalGb: num(last.memTotal),
				diskPercent: latest.diskPercent,
				diskGb: latest.diskGb,
				diskTotalGb: totalDisk,
				netIn: latest.netIn,
				netOut: latest.netOut,
			}}
			cpu={{
				average:
					series.reduce((sum, point) => sum + point.cpu, 0) / series.length,
				peak: peak.cpu,
				peakAt: peak.time,
			}}
			busiest={series.reduce(
				(top, point) => Math.max(top, point.netIn ?? 0, point.netOut ?? 0),
				0,
			)}
			seconds={seconds}
			thresholds={settings.thresholds}
		/>
	);
}

/** The four charts of a server, from buckets the collector summarised. */
function BucketChartsView({
	buckets,
	latest,
	stepMs,
	domain,
	range,
	settings,
}: {
	buckets: MetricBucket[];
	latest: LatestMetric | null;
	stepMs: number;
	domain: readonly [number, number];
	range: Range;
	settings: Pick<Settings, "refreshRate" | "thresholds">;
}) {
	const chosen = RANGES.find((item) => item.value === range) ?? RANGES[2];
	const points = useMemo(
		() =>
			bucketPoints(buckets, METRIC_KEYS, {
				stepMs,
				// Readings further apart than three of their usual interval are
				// an outage, as in the charts that bucket readings themselves.
				gapMs: 3 * (bucketInterval(buckets) || settings.refreshRate * 1000),
			}),
		[buckets, stepMs, settings.refreshRate],
	);
	if (!latest) return <NoReadings settings={settings} />;
	if (buckets.length === 0) {
		return (
			<NoReadings
				settings={settings}
				title={`No readings in the last ${chosen.label}`}
				description={`The newest reading is from ${format(latest.time, "d MMM yyyy HH:mm")}.`}
			/>
		);
	}
	return (
		<MetricPanels
			chart={{ points }}
			domain={domain}
			latest={latest}
			cpu={cpuSummary(buckets)}
			busiest={busiestRate(buckets)}
			seconds={chosen.seconds}
			thresholds={settings.thresholds}
		/>
	);
}

function MetricPanels({
	chart,
	domain,
	latest,
	cpu,
	busiest,
	seconds,
	thresholds,
}: {
	chart: { readings: Point[] } | { points: ChartPoint<MetricKey>[] };
	domain?: readonly [number, number];
	latest: LatestMetric;
	/** Over everything the charts show. */
	cpu: { average: number; peak: number; peakAt: number } | null;
	/** The highest network rate shown, in MB/s. */
	busiest: number;
	seconds: number;
	thresholds: Settings["thresholds"];
}) {
	const peakFormat = seconds > 86400 ? "d MMM HH:mm" : "HH:mm";
	// Under 1 MB/s the chart counts in KB/s, so its axis ends on a round
	// number of the unit it shows.
	const inKb = busiest < 1;
	const unit = inKb ? "KB/s" : "MB/s";
	const shared = { ...chart, domain, tickChars: TICK_CHARS, syncId: SYNC_ID };
	return (
		<div className="grid gap-4 lg:grid-cols-2">
			<MetricPanel
				icon={CpuIcon}
				label={`CPU${latest.cpuCores ? ` · ${latest.cpuCores} vCPU` : ""}`}
				meta={
					cpu
						? `avg ${cpu.average.toFixed(0)}% · peak ${cpu.peak.toFixed(0)}% at ${format(cpu.peakAt, peakFormat)}`
						: undefined
				}
				value={`${latest.cpu.toFixed(0)}%`}
			>
				<MetricChart
					{...shared}
					label="CPU use"
					series={CPU}
					max={100}
					formatValue={formatPercent}
					threshold={thresholds.cpu || undefined}
				/>
			</MetricPanel>
			<MetricPanel
				icon={MemoryStickIcon}
				label={`Memory · ${formatGb(latest.memTotalGb)} GB`}
				value={`${formatGb(latest.memGb)} GB`}
				detail={`${latest.memPercent.toFixed(0)}%`}
			>
				<MetricChart
					{...shared}
					label="Memory use"
					series={MEMORY}
					max={100}
					formatValue={formatPercent}
					threshold={thresholds.memory || undefined}
				/>
			</MetricPanel>
			<MetricPanel
				icon={HardDriveIcon}
				label={`Disk · ${formatGb(latest.diskTotalGb)} GB`}
				value={`${formatGb(latest.diskGb)} GB`}
				detail={`${latest.diskPercent.toFixed(0)}%`}
			>
				<MetricChart
					{...shared}
					label="Disk use"
					series={DISK}
					max={100}
					formatValue={formatPercent}
				/>
			</MetricPanel>
			<MetricPanel
				icon={ArrowUpDownIcon}
				label="Network"
				legend={<MetricLegend series={NETWORK} />}
				value={formatRate(latest.netIn ?? 0)}
				detail={`in · ${formatRate(latest.netOut ?? 0)} out`}
			>
				<MetricChart
					{...shared}
					label="Network in and out"
					series={NETWORK}
					summary="peak"
					floor={inKb ? 10 / 1024 : 1}
					formatValue={formatRate}
					formatTick={(value) =>
						value === 0
							? "0"
							: `${Number((inKb ? value * 1024 : value).toPrecision(3))} ${unit}`
					}
					tickUnit={inKb ? 1 / 1024 : 1}
				/>
			</MetricPanel>
		</div>
	);
}

const CPU: MetricSeries<"cpu">[] = [{ key: "cpu", label: "CPU" }];
const MEMORY: MetricSeries<"memPercent">[] = [
	{ key: "memPercent", label: "Memory" },
];
const DISK: MetricSeries<"diskPercent">[] = [
	{ key: "diskPercent", label: "Disk" },
];
const NETWORK: MetricSeries<"netIn" | "netOut">[] = [
	{ key: "netIn", label: "In" },
	{ key: "netOut", label: "Out", muted: true },
];

function MetricPanel({
	icon: Icon,
	label,
	meta,
	value,
	detail,
	legend,
	children,
}: {
	icon: LucideIcon;
	label: string;
	meta?: string;
	value: string;
	detail?: string;
	legend?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<section className="flex min-w-0 flex-col gap-3 rounded-xl border border-border p-4">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="flex items-center gap-1.5 text-muted-foreground text-sm">
						<Icon aria-hidden="true" className="size-3.5 shrink-0" />
						{label}
					</p>
					<p className="mt-1 font-semibold text-xl tabular-nums">
						{value}
						{detail ? (
							<span className="ml-1.5 font-normal text-muted-foreground text-sm">
								{detail}
							</span>
						) : null}
					</p>
				</div>
				{legend ??
					(meta ? (
						<p className="shrink-0 text-muted-foreground text-xs">{meta}</p>
					) : null)}
			</div>
			{children}
		</section>
	);
}

const DEFAULT_THRESHOLD = 85;

function AlertsSection({
	serverId,
	config,
}: {
	serverId: string | undefined;
	config: Config;
}) {
	const ref = useServerRef();
	const save = useSaveMonitoring(serverId);
	const { settings } = config;
	const [turnOffOpen, setTurnOffOpen] = useState(false);
	const { active } = useOrganization();
	const remove = useMutation(api.live.monitoring.remove);

	const setThreshold = async (key: "cpu" | "memory", value: number) => {
		try {
			await save(
				{ ...settings, thresholds: { ...settings.thresholds, [key]: value } },
				{ deploy: false },
			);
			toast.success("Saved. Monitoring restarts on the server to apply it.");
		} catch (error) {
			toast.error(errorMessage(error));
		}
	};

	return (
		<Section
			title="Alerts"
			icon={BellIcon}
			hint="Sent to your notification channels; dashed lines on the charts"
			actions={
				<Button
					variant="ghost"
					size="sm"
					nativeButton={false}
					render={<Link href="/settings/notifications" />}
				>
					Notification channels
				</Button>
			}
		>
			<ThresholdRow
				label="CPU"
				value={settings.thresholds.cpu}
				onChange={(value) => setThreshold("cpu", value)}
			/>
			<ThresholdRow
				label="Memory"
				value={settings.thresholds.memory}
				onChange={(value) => setThreshold("memory", value)}
			/>
			<div className="flex flex-wrap items-center justify-between gap-3 pt-3">
				<FootNote>
					Metrics kept for {settings.retentionDays}{" "}
					{settings.retentionDays === 1 ? "day" : "days"} · collected every{" "}
					{settings.refreshRate} s
				</FootNote>
				<div className="flex items-center gap-2">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setTurnOffOpen(true)}
					>
						Turn off
					</Button>
					<Button
						variant="outline"
						size="sm"
						nativeButton={false}
						render={
							<Link href={serverUrl(ref.routeId, "monitoring/settings")} />
						}
					>
						<SlidersHorizontalIcon data-icon="inline-start" />
						Monitoring settings
					</Button>
				</div>
			</div>
			<ConfirmDialog
				open={turnOffOpen}
				onOpenChange={setTurnOffOpen}
				title="Turn off monitoring?"
				description="Removes the monitoring service from the server. Its history and alerts stop until you turn it on again."
				confirmLabel="Turn off"
				onConfirm={() =>
					remove({
						organizationId: active.id,
						serverId: serverId as Id<"servers"> | undefined,
					})
				}
			/>
		</Section>
	);
}

function ThresholdRow({
	label,
	value,
	onChange,
}: {
	label: string;
	value: number;
	onChange: (value: number) => Promise<void>;
}) {
	const on = value > 0;
	const [draft, setDraft] = useState(String(value || DEFAULT_THRESHOLD));
	const [pending, setPending] = useState(false);
	const commit = async (next: number) => {
		if (next === value) return;
		setPending(true);
		await onChange(next);
		setPending(false);
	};
	return (
		<div className="flex min-h-12 items-center gap-4 border-border border-b py-2 text-sm">
			<span className="w-40 shrink-0 font-medium">{label}</span>
			<span className="flex flex-1 items-center gap-1.5 text-muted-foreground">
				{on ? (
					<>
						above
						<Input
							aria-label={`${label} threshold`}
							value={draft}
							inputMode="numeric"
							disabled={pending}
							onChange={(event) => setDraft(event.target.value)}
							onBlur={() => {
								const next = Math.round(Number(draft));
								if (Number.isFinite(next) && next >= 1 && next <= 100) {
									void commit(next);
								} else {
									setDraft(String(value));
								}
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter") event.currentTarget.blur();
							}}
							className="h-7 w-14 px-2 font-mono text-[13px] text-foreground"
						/>
						%
					</>
				) : (
					"Off"
				)}
			</span>
			{pending ? (
				<Loader2 className="size-4 animate-spin text-muted-foreground" />
			) : null}
			<Switch
				aria-label={`${label} alert`}
				checked={on}
				disabled={pending}
				onCheckedChange={(checked) => {
					const next = checked ? Number(draft) || DEFAULT_THRESHOLD : 0;
					if (checked) setDraft(String(next));
					void commit(next);
				}}
			/>
		</div>
	);
}
