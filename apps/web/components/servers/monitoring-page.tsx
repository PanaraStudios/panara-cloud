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
	HardDriveIcon,
	Loader2,
	type LucideIcon,
	MemoryStickIcon,
	SlidersHorizontalIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
	Area,
	AreaChart,
	CartesianGrid,
	Line,
	LineChart,
	ReferenceLine,
	XAxis,
	YAxis,
} from "recharts";
import { toast } from "sonner";
import { ContainerFreeMonitoring } from "@/components/dashboard/monitoring/free/container/show-free-container-monitoring";
import {
	HOST_APP_NAME,
	useMetrics,
} from "@/components/dashboard/monitoring/live-stats";
import { Button } from "@/components/ui/button";
import { type ChartConfig, ChartContainer } from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
	ConfirmDialog,
	EmptyState,
	Section,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { serverUrl } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import {
	type MonitoringConfig,
	MonitoringDeployStatus,
	type MonitoringSettings,
	useMonitoringConfig,
	useSaveMonitoring,
} from "./monitoring-setup";
import { FilterPills, FootNote, ListSkeleton, LoadFailed } from "./server-ui";
import { useServerRef } from "./use-server";

type Config = MonitoringConfig;
type Settings = MonitoringSettings;

const RANGES = [
	{ value: "1h", label: "1h", seconds: 3600 },
	{ value: "6h", label: "6h", seconds: 6 * 3600 },
	{ value: "24h", label: "24h", seconds: 24 * 3600 },
	{ value: "7d", label: "7d", seconds: 7 * 86400 },
	{ value: "30d", label: "30d", seconds: 30 * 86400 },
] as const;
type Range = (typeof RANGES)[number]["value"];

const MAX_POINTS = 10_000;

type RawMetric = {
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
	netIn: number;
	netOut: number;
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
				: 0;
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
									title: kept ? undefined : "Older than the metrics kept",
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
						<Section title="Live usage" hint="Right now; nothing is kept">
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

function MetricCharts({
	serverId,
	range,
	settings,
}: {
	serverId: string | undefined;
	range: Range;
	settings: Settings;
}) {
	const { active } = useOrganization();
	const seconds = RANGES.find((item) => item.value === range)?.seconds ?? 86400;
	const points = Math.min(
		MAX_POINTS,
		Math.max(2, Math.ceil(seconds / settings.refreshRate)),
	);
	const { data, isLoading, error } = useMetrics(
		{
			type: "host",
			organizationId: active.id,
			serverId: serverId as Id<"servers"> | undefined,
		},
		String(points),
		Math.max(5, settings.refreshRate) * 1000,
	);
	const series = useMemo(() => toPoints((data ?? []) as RawMetric[]), [data]);
	if (isLoading) return <ListSkeleton rows={4} />;
	if (error) {
		return <LoadFailed icon={ChartColumnIcon} what="metrics" error={error} />;
	}
	const latest = series[series.length - 1];
	const raw = (data ?? []) as RawMetric[];
	const last = raw[raw.length - 1];
	if (!latest || !last) {
		return (
			<EmptyState
				icon={ChartColumnIcon}
				title="No readings yet"
				description={`The monitoring service reports every ${settings.refreshRate} s; the first readings show up here shortly.`}
			/>
		);
	}
	const peak = series.reduce((top, point) =>
		point.cpu > top.cpu ? point : top,
	);
	const average =
		series.reduce((sum, point) => sum + point.cpu, 0) / series.length;
	const timeFormat = seconds > 86400 ? "d MMM" : "HH:mm";
	const cpuThreshold = settings.thresholds.cpu;
	const memoryThreshold = settings.thresholds.memory;
	const totalDisk = num(last.totalDisk);
	return (
		<div className="grid gap-4 lg:grid-cols-2">
			<MetricPanel
				icon={CpuIcon}
				label={`CPU${last.cpuCores ? ` · ${last.cpuCores} vCPU` : ""}`}
				meta={`avg ${average.toFixed(0)}% · peak ${peak.cpu.toFixed(0)}% at ${format(peak.time, timeFormat)}`}
				value={`${latest.cpu.toFixed(0)}%`}
				data={series}
				lines={[{ key: "cpu" }]}
				domain={[0, 100]}
				threshold={cpuThreshold || undefined}
				timeFormat={timeFormat}
			/>
			<MetricPanel
				icon={MemoryStickIcon}
				label={`Memory · ${formatGb(num(last.memTotal))} GB`}
				value={`${formatGb(latest.memGb)} GB`}
				detail={`${latest.memPercent.toFixed(0)}%`}
				data={series}
				lines={[{ key: "memPercent" }]}
				domain={[0, 100]}
				threshold={memoryThreshold || undefined}
				timeFormat={timeFormat}
			/>
			<MetricPanel
				icon={HardDriveIcon}
				label={`Disk · ${formatGb(totalDisk)} GB`}
				value={`${formatGb(latest.diskGb)} GB`}
				detail={`${latest.diskPercent.toFixed(0)}%`}
				data={series}
				lines={[{ key: "diskPercent" }]}
				domain={[0, 100]}
				timeFormat={timeFormat}
			/>
			<MetricPanel
				icon={ArrowUpDownIcon}
				label="Network"
				legend
				value={formatRate(latest.netIn)}
				detail={`in · ${formatRate(latest.netOut)} out`}
				data={series.slice(1)}
				lines={[
					{ key: "netIn", label: "In" },
					{ key: "netOut", label: "Out", muted: true },
				]}
				timeFormat={timeFormat}
			/>
		</div>
	);
}

const chartConfig = {
	cpu: { label: "CPU", color: "var(--foreground)" },
	memPercent: { label: "Memory", color: "var(--foreground)" },
	diskPercent: { label: "Disk", color: "var(--foreground)" },
	netIn: { label: "In", color: "var(--foreground)" },
	netOut: { label: "Out", color: "var(--muted-foreground)" },
} satisfies ChartConfig;

function MetricPanel({
	icon: Icon,
	label,
	meta,
	value,
	detail,
	data,
	lines,
	domain,
	threshold,
	timeFormat,
	legend,
}: {
	icon: LucideIcon;
	label: string;
	meta?: string;
	value: string;
	detail?: string;
	data: Point[];
	lines: { key: keyof Point; label?: string; muted?: boolean }[];
	domain?: [number, number];
	threshold?: number;
	timeFormat: string;
	legend?: boolean;
}) {
	const axis = (
		<XAxis
			dataKey="time"
			type="number"
			scale="time"
			domain={["dataMin", "dataMax"]}
			tickLine={false}
			axisLine={false}
			tickMargin={8}
			minTickGap={48}
			tick={{ fontSize: 11, fontFamily: "var(--font-mono)" }}
			tickFormatter={(time: number) => format(time, timeFormat)}
		/>
	);
	const yAxis = <YAxis hide domain={domain ?? [0, "auto"]} />;
	const grid = <CartesianGrid vertical={false} strokeOpacity={0.5} />;
	const reference =
		threshold !== undefined ? (
			<ReferenceLine
				y={threshold}
				stroke="var(--warning)"
				strokeDasharray="4 4"
				ifOverflow="extendDomain"
			/>
		) : null;
	return (
		<section className="flex flex-col gap-3 rounded-xl border border-border p-4">
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
				{legend ? (
					<div className="flex shrink-0 items-center gap-3 text-muted-foreground text-xs">
						{lines.map((line) => (
							<span key={line.key} className="flex items-center gap-1.5">
								<span
									className={cn(
										"h-0.5 w-3 rounded-full",
										line.muted ? "bg-muted-foreground" : "bg-foreground",
									)}
								/>
								{line.label}
							</span>
						))}
					</div>
				) : meta ? (
					<p className="shrink-0 text-muted-foreground text-xs">{meta}</p>
				) : null}
			</div>
			<ChartContainer config={chartConfig} className="aspect-auto h-44 w-full">
				{lines.length > 1 ? (
					<LineChart data={data} margin={{ left: 0, right: 0, top: 8 }}>
						{grid}
						{axis}
						{yAxis}
						{lines.map((line) => (
							<Line
								key={line.key}
								dataKey={line.key}
								type="monotone"
								dot={false}
								isAnimationActive={false}
								stroke={
									line.muted ? "var(--muted-foreground)" : "var(--foreground)"
								}
								strokeWidth={1.5}
							/>
						))}
					</LineChart>
				) : (
					<AreaChart data={data} margin={{ left: 0, right: 0, top: 8 }}>
						{grid}
						{axis}
						{yAxis}
						{reference}
						{lines.map((line) => (
							<Area
								key={line.key}
								dataKey={line.key}
								type="monotone"
								isAnimationActive={false}
								stroke="var(--foreground)"
								strokeWidth={1.5}
								fill="var(--foreground)"
								fillOpacity={0.06}
							/>
						))}
					</AreaChart>
				)}
			</ChartContainer>
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
