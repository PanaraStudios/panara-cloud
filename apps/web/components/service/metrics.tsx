"use client";

import { GaugeIcon, Loader2Icon } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useServiceContainers } from "@/components/dashboard/docker/logs/use-service-containers";
import { ContainerFreeMonitoring } from "@/components/dashboard/monitoring/free/container/show-free-container-monitoring";
import {
	MetricChart,
	MetricLegend,
	type MetricSeries,
} from "@/components/ui/metric-chart";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-kit/primitives";
import { serverUrl } from "@/lib/navigation";
import { serviceStatusWord } from "@/lib/service-actions";
import { cn } from "@/lib/utils";
import { FilterPills } from "./filter-pills";
import { HostUnreachable } from "./logs";
import { runtimeOf, useNotDeployed, useService } from "./service-context";
import {
	formatBytes,
	formatRate,
	type StatPoint,
	useServiceStats,
} from "./stats";
import { shortSha, useServiceDeployments } from "./use-service-deployments";

function NoReadingsYet() {
	const { service } = useService();
	return (
		<EmptyState
			icon={GaugeIcon}
			title="No readings yet"
			description={`${service.name} hasn't been deployed. Once it runs, its CPU, memory, network and disk are charted here.`}
		/>
	);
}

/** Where the charts of the whole server live. */
function ServerMonitoringNote({ children }: { children?: React.ReactNode }) {
	const { service } = useService();
	return (
		<p className="text-muted-foreground text-sm">
			{children}
			Server-wide charts are in{" "}
			<Link
				href={serverUrl(service.serverId ?? "local", "monitoring")}
				className="font-medium text-foreground hover:underline"
			>
				{service.serverName ?? "Panara Cloud host"} monitoring
			</Link>
			.
		</p>
	);
}

// A compose project runs several containers; metrics follow one at a time.
function ComposeMetrics() {
	const { service } = useService();
	const composeType = service.compose?.composeType ?? "docker-compose";
	const { containers, isLoading, error } = useServiceContainers(
		service.appName,
		service.serverId ?? undefined,
		true,
		composeType,
		{ id: service.id, kind: service.family },
	);
	const [name, setName] = useState<string | undefined>();
	useEffect(() => {
		if (!name && containers?.[0]) setName(containers[0].name);
	}, [containers, name]);
	if (error && !containers) {
		return <HostUnreachable what="Readings" detail={error} />;
	}
	if (!isLoading && (containers?.length ?? 0) === 0) {
		return (
			<EmptyState
				icon={GaugeIcon}
				title="No containers running"
				description={`Start or deploy ${service.name} to chart its containers here.`}
			/>
		);
	}
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-2">
				<Select names="container" value={name ?? ""} onValueChange={setName}>
					<SelectTrigger
						size="sm"
						aria-label="Container"
						className="h-8 w-fit min-w-64"
					>
						{isLoading ? (
							<span className="flex items-center gap-2 text-muted-foreground">
								<Loader2Icon className="size-3.5 animate-spin" />
								Loading containers…
							</span>
						) : (
							<span className="flex min-w-0 items-center gap-1.5">
								<span className="text-muted-foreground">Container</span>
								<span className="truncate font-mono text-[13px]">
									<SelectValue placeholder="none" />
								</span>
							</span>
						)}
					</SelectTrigger>
					<SelectContent align="start">
						<SelectGroup>
							<SelectLabel>Containers ({containers?.length ?? 0})</SelectLabel>
							{(containers ?? []).map((container) => (
								<SelectItem key={container.containerId} value={container.name}>
									<span className="font-mono text-[13px]">
										{container.name}
									</span>
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
			</div>
			{name ? (
				<ContainerFreeMonitoring
					embedded
					appName={name}
					appType={composeType}
					serviceId={service.id}
					serviceKind="compose"
					serverId={service.serverId ?? undefined}
				/>
			) : (
				<ChartsSkeleton />
			)}
			<ServerMonitoringNote />
		</div>
	);
}

function ChartsSkeleton() {
	return (
		<div className="grid gap-4 lg:grid-cols-2" aria-busy="true">
			{[0, 1, 2, 3].map((panel) => (
				<Skeleton key={panel} className="h-56 rounded-xl" />
			))}
		</div>
	);
}

const RANGES = [
	{ value: "15m", label: "15 min", ms: 15 * 60_000 },
	{ value: "1h", label: "1 hour", ms: 60 * 60_000 },
] as const;
type Range = (typeof RANGES)[number]["value"];

const clock = (at: number) =>
	new Date(at).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});

const SYNC_ID = "service-metrics";
// Readings are kept every 10 s and arrive every 2 s while the page is open.
// Going by the faster pace would turn the kept ones into single dots.
const GAP_MS = 30_000;
// "100 MB/s": the four plots start at the same place.
const TICK_CHARS = 8;

const CPU: MetricSeries<"cpu">[] = [{ key: "cpu", label: "CPU" }];
const MEMORY: MetricSeries<"memory">[] = [{ key: "memory", label: "Memory" }];
const NETWORK: MetricSeries<"netIn" | "netOut">[] = [
	{ key: "netIn", label: "In" },
	{ key: "netOut", label: "Out", muted: true },
];
const DISK: MetricSeries<"read" | "write">[] = [
	{ key: "read", label: "Read" },
	{ key: "write", label: "Write", muted: true },
];

const formatCpu = (value: number) =>
	`${value > 0 && value < 10 ? value.toFixed(1) : Math.round(value)}%`;

const bytesLabel = (bytes: number) => {
	const { value, unit } = formatBytes(bytes);
	return `${value} ${unit}`;
};

// An axis in the unit its top value reads in, ending on a round number of it.
const byteAxis = (peak: number) => {
	const unit = peak >= 1024 ** 3 ? "GB" : peak >= 1024 ** 2 ? "MB" : "KB";
	const size = { GB: 1024 ** 3, MB: 1024 ** 2, KB: 1024 }[unit];
	return {
		tickUnit: size,
		floor: size,
		formatTick: (value: number) =>
			value === 0 ? "0" : `${Number((value / size).toPrecision(3))} ${unit}`,
	};
};

const rateAxis = (peak: number) => {
	const inKb = peak < 1;
	const size = inKb ? 1 / 1000 : 1;
	return {
		tickUnit: size,
		floor: inKb ? 10 / 1000 : 1,
		formatTick: (value: number) =>
			value === 0
				? "0"
				: `${Number((value / size).toPrecision(3))} ${inKb ? "KB/s" : "MB/s"}`,
	};
};

/** What a dashed line on a chart stands for. */
function DashKey({
	tone,
	children,
}: {
	tone: "warning" | "destructive";
	children: React.ReactNode;
}) {
	return (
		<span className="flex min-w-0 items-center gap-1.5">
			<span
				className={cn(
					"w-3 shrink-0 border-t border-dashed",
					tone === "warning" ? "border-warning" : "border-destructive/60",
				)}
			/>
			<span className="truncate">{children}</span>
		</span>
	);
}

function ChartCard({
	title,
	value,
	children,
	footer,
}: {
	title: string;
	value: React.ReactNode;
	children: React.ReactNode;
	footer?: React.ReactNode;
}) {
	return (
		<section className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4">
			<div className="flex items-baseline justify-between gap-3">
				<h2 className="font-medium text-sm">{title}</h2>
				<div className="text-muted-foreground text-sm tabular-nums">
					{value}
				</div>
			</div>
			{children}
			{footer ? (
				<div className="flex min-h-4 items-center text-muted-foreground text-xs tabular-nums">
					{footer}
				</div>
			) : null}
		</section>
	);
}

type ServiceReading = StatPoint & { time: number };

/** The four charts of a service, from its readings (oldest first). */
export function ServiceChartGrid({
	readings,
	markers,
	memoryLimit,
	cpuLimit,
}: {
	readings: readonly ServiceReading[];
	/** Deploys inside the charted time. */
	markers: readonly { at: number; sha?: string | null }[];
	/** The service's own memory limit in bytes; 0 without one. */
	memoryLimit: number;
	cpuLimit: number | null;
}) {
	const last = readings.at(-1);
	const memory = last ? formatBytes(last.memory) : null;
	const total = last?.memoryLimit ? formatBytes(last.memoryLimit) : null;
	const peak = (pick: (point: StatPoint) => number) =>
		readings.reduce((top, point) => Math.max(top, pick(point)), 0);
	const memoryAxis = byteAxis(
		Math.max(
			memoryLimit,
			peak((p) => p.memory),
		),
	);
	const networkAxis = rateAxis(peak((p) => Math.max(p.netIn, p.netOut)));
	const diskAxis = rateAxis(peak((p) => Math.max(p.read, p.write)));

	return (
		<div className="grid gap-4 lg:grid-cols-2">
			<ChartCard
				title="CPU"
				value={
					<>
						<span className="font-semibold text-foreground text-xl">
							{last ? `${Math.round(last.cpu)}%` : "—"}
						</span>{" "}
						{cpuLimit ? `of ${cpuLimit} vCPU limit` : "of one core"}
					</>
				}
				footer={
					markers[0] ? (
						<DashKey tone="warning">
							Deploy {markers[0].sha ?? ""} · {clock(markers[0].at)}
						</DashKey>
					) : undefined
				}
			>
				<MetricChart
					label="CPU use"
					readings={readings}
					series={CPU}
					floor={cpuLimit ? cpuLimit * 100 : 100}
					formatValue={formatCpu}
					formatTick={(value) => `${Math.round(value)}%`}
					tickChars={TICK_CHARS}
					markers={markers.map((marker) => marker.at)}
					gapMs={GAP_MS}
					syncId={SYNC_ID}
				/>
			</ChartCard>
			<ChartCard
				title="Memory"
				value={
					<>
						<span className="font-semibold text-foreground text-xl">
							{memory ? `${memory.value} ${memory.unit}` : "—"}
						</span>{" "}
						{total ? `of ${total.value} ${total.unit}` : ""}
					</>
				}
				footer={
					memoryLimit ? (
						<DashKey tone="destructive">
							Limit {bytesLabel(memoryLimit)}
						</DashKey>
					) : undefined
				}
			>
				<MetricChart
					label="Memory use"
					readings={readings}
					series={MEMORY}
					{...memoryAxis}
					formatValue={bytesLabel}
					tickChars={TICK_CHARS}
					threshold={memoryLimit || undefined}
					thresholdTone="destructive"
					gapMs={GAP_MS}
					syncId={SYNC_ID}
				/>
			</ChartCard>
			<ChartCard
				title="Network"
				value={
					last ? (
						<>
							in{" "}
							<span className="text-foreground">{formatRate(last.netIn)}</span>{" "}
							· out{" "}
							<span className="text-foreground">{formatRate(last.netOut)}</span>
						</>
					) : (
						"—"
					)
				}
				footer={<MetricLegend series={NETWORK} />}
			>
				<MetricChart
					label="Network in and out"
					readings={readings}
					series={NETWORK}
					summary="peak"
					{...networkAxis}
					formatValue={formatRate}
					tickChars={TICK_CHARS}
					gapMs={GAP_MS}
					syncId={SYNC_ID}
				/>
			</ChartCard>
			<ChartCard
				title="Disk I/O"
				value={
					last ? (
						<>
							read{" "}
							<span className="text-foreground">{formatRate(last.read)}</span> ·
							write{" "}
							<span className="text-foreground">{formatRate(last.write)}</span>
						</>
					) : (
						"—"
					)
				}
				footer={<MetricLegend series={DISK} />}
			>
				<MetricChart
					label="Disk reads and writes"
					readings={readings}
					series={DISK}
					summary="peak"
					{...diskAxis}
					formatValue={formatRate}
					tickChars={TICK_CHARS}
					gapMs={GAP_MS}
					syncId={SYNC_ID}
				/>
			</ChartCard>
		</div>
	);
}

/** CPU, memory, network and disk I/O of one application or database. */
function ServiceCharts() {
	const { service, pending } = useService();
	const stopped =
		serviceStatusWord(service.status, runtimeOf(pending)) === "stopped";
	const [range, setRange] = useState<Range>("1h");
	const { points, loading, error } = useServiceStats(service, { live: true });
	const deployments = useServiceDeployments(service);
	const windowMs = RANGES.find((item) => item.value === range)?.ms ?? 0;
	const readings = useMemo(() => {
		const start = (points.at(-1)?.at ?? Date.now()) - windowMs;
		return points
			.filter((point) => point.at >= start)
			.map((point) => ({ ...point, time: point.at }));
	}, [points, windowMs]);
	const first = readings[0]?.time ?? 0;
	const last = readings.at(-1);
	const end = last?.time ?? 0;
	const markers = (deployments ?? [])
		.filter(
			(row) =>
				row.status === "succeeded" &&
				row.finishedAt !== undefined &&
				row.finishedAt >= first &&
				row.finishedAt <= end,
		)
		.map((row) => ({ at: row.finishedAt ?? 0, sha: shortSha(row) }));
	// Without a limit of its own a container reports the host's memory as its
	// limit; scaling the chart to that would flatten the line.
	const memoryLimit = Number(
		service.application?.memoryLimit ?? service.database?.memoryLimit ?? 0,
	);
	const cpuLimit = service.application?.cpuLimit
		? Number(service.application.cpuLimit) / 1e9
		: null;

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<FilterPills
					aria-label="Range"
					value={range}
					onValueChange={setRange}
					items={RANGES}
				/>
				<p className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm">
					<span
						className={cn(
							"size-1.5 shrink-0 rounded-full",
							error ? "bg-muted-foreground" : "bg-success",
						)}
					/>
					{error ? "Not live" : "Live · every 10 s"}
					<span aria-hidden="true">·</span>
					<span className="truncate font-mono text-[13px]">
						{service.appName}
					</span>
				</p>
			</div>
			{loading ? (
				<ChartsSkeleton />
			) : readings.length < 2 && stopped ? (
				// No container to read: that is the service, not its server.
				<EmptyState
					icon={GaugeIcon}
					title={`${service.name} is stopped`}
					description="Nothing runs, so there is nothing to chart. Readings start again when it is started or deployed."
				/>
			) : readings.length < 2 && error ? (
				<HostUnreachable what="Readings" detail={error} />
			) : readings.length < 2 ? (
				<EmptyState
					icon={GaugeIcon}
					title="No readings yet"
					description="Readings start once the service is running. Keep this page open to collect them."
				/>
			) : (
				<ServiceChartGrid
					readings={readings}
					markers={markers}
					memoryLimit={memoryLimit}
					cpuLimit={cpuLimit}
				/>
			)}
			<ServerMonitoringNote>
				Readings are kept for about 48 minutes.{" "}
			</ServerMonitoringNote>
		</div>
	);
}

export function ServiceMetrics() {
	const { service } = useService();
	const notDeployed = useNotDeployed();
	if (notDeployed === undefined) return <ChartsSkeleton />;
	if (notDeployed) return <NoReadingsYet />;
	if (service.family === "compose") return <ComposeMetrics />;
	return <ServiceCharts />;
}
