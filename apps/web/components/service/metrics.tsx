"use client";

import { GaugeIcon, Loader2Icon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useServiceContainers } from "@/components/dashboard/docker/logs/use-service-containers";
import { ContainerFreeMonitoring } from "@/components/dashboard/monitoring/free/container/show-free-container-monitoring";
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
import { cn } from "@/lib/utils";
import { FilterPills } from "./filter-pills";
import { HostUnreachable } from "./logs";
import { useNotDeployed, useService } from "./service-context";
import { formatBytes, formatRate, LineChart, useServiceStats } from "./stats";
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
				<Select value={name ?? ""} onValueChange={setName}>
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
				<div className="flex justify-between text-muted-foreground text-xs tabular-nums">
					{footer}
				</div>
			) : null}
		</section>
	);
}

/** CPU, memory, network and disk I/O of one application or database. */
function ServiceCharts() {
	const { service } = useService();
	const [range, setRange] = useState<Range>("1h");
	const { points, loading, error } = useServiceStats(service, { live: true });
	const deployments = useServiceDeployments(service);
	const windowMs = RANGES.find((item) => item.value === range)?.ms ?? 0;
	const end = points.at(-1)?.at ?? Date.now();
	const start = end - windowMs;
	const visible = points.filter((point) => point.at >= start);
	const first = visible[0]?.at ?? start;
	const span = Math.max(1, end - first);
	const markers = (deployments ?? [])
		.filter(
			(row) =>
				row.status === "succeeded" &&
				row.finishedAt !== undefined &&
				row.finishedAt >= first &&
				row.finishedAt <= end,
		)
		.map((row) => ({
			at: (row.finishedAt ?? 0) - first,
			sha: shortSha(row),
		}));
	const last = visible.at(-1);
	const memory = last ? formatBytes(last.memory) : null;
	const limit = last?.memoryLimit ? formatBytes(last.memoryLimit) : null;
	const cpuLimit = service.application?.cpuLimit
		? Number(service.application.cpuLimit) / 1e9
		: null;
	const timeFooter = (middle?: React.ReactNode) => (
		<>
			<span>{clock(first)}</span>
			{middle ? <span>{middle}</span> : null}
			<span>{clock(end)}</span>
		</>
	);
	const deployLabel = markers[0]
		? `Deploy ${markers[0].sha ?? ""} · ${clock(first + markers[0].at)}`
		: undefined;

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
			) : visible.length < 2 && error ? (
				<HostUnreachable what="Readings" detail={error} />
			) : visible.length < 2 ? (
				<EmptyState
					icon={GaugeIcon}
					title="No readings yet"
					description="Readings start once the service is running. Keep this page open to collect them."
				/>
			) : (
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
						footer={timeFooter(deployLabel)}
					>
						<LineChart
							label="CPU use"
							series={[{ values: visible.map((p) => p.cpu) }]}
							markers={markers.map((m) => m.at / span)}
						/>
					</ChartCard>
					<ChartCard
						title="Memory"
						value={
							<>
								<span className="font-semibold text-foreground text-xl">
									{memory ? `${memory.value} ${memory.unit}` : "—"}
								</span>{" "}
								{limit ? `of ${limit.value} ${limit.unit}` : ""}
							</>
						}
						footer={timeFooter(
							limit ? `limit ${limit.value} ${limit.unit}` : "no limit",
						)}
					>
						<LineChart
							label="Memory use"
							series={[{ values: visible.map((p) => p.memory) }]}
							limit={last?.memoryLimit || undefined}
						/>
					</ChartCard>
					<ChartCard
						title="Network"
						value={
							last ? (
								<>
									in{" "}
									<span className="text-foreground">
										{formatRate(last.netIn)}
									</span>{" "}
									· out{" "}
									<span className="text-foreground">
										{formatRate(last.netOut)}
									</span>
								</>
							) : (
								"—"
							)
						}
					>
						<LineChart
							label="Network in and out"
							height={110}
							series={[
								{ values: visible.map((p) => p.netOut) },
								{ values: visible.map((p) => p.netIn), muted: true },
							]}
						/>
					</ChartCard>
					<ChartCard
						title="Disk I/O"
						value={
							last ? (
								<>
									read{" "}
									<span className="text-foreground">
										{formatRate(last.read)}
									</span>{" "}
									· write{" "}
									<span className="text-foreground">
										{formatRate(last.write)}
									</span>
								</>
							) : (
								"—"
							)
						}
					>
						<LineChart
							label="Disk reads and writes"
							height={110}
							series={[
								{ values: visible.map((p) => p.write) },
								{ values: visible.map((p) => p.read), muted: true },
							]}
						/>
					</ChartCard>
				</div>
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
