"use client";

import { api } from "@panara-cloud/backend/api";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	MetricChart,
	MetricLegend,
	type MetricSeries,
} from "@/components/ui/metric-chart";
import { Progress } from "@/components/ui/progress";
import { useQueryResult } from "@/lib/host-data";
import type { LiveRequest } from "@/lib/live";
import { formatMb } from "@/lib/shared/monitoring-units";
import {
	HOST_APP_NAME,
	isHostStats,
	type ServiceKind,
	statsFromContainer,
	statsFromHost,
	useLiveData,
	useServiceScope,
} from "../../live-stats";
import { DockerDiskUsageChart } from "./docker-disk-usage-chart";

const defaultData = {
	cpu: {
		value: "0%",
		time: "",
	},
	memory: {
		value: {
			used: 0,
			total: 0,
		},
		time: "",
	},
	block: {
		value: {
			readMb: 0,
			writeMb: 0,
		},
		time: "",
	},
	network: {
		value: {
			inputMb: 0,
			outputMb: 0,
		},
		time: "",
	},
	disk: {
		value: { diskTotal: 0, diskUsage: 0, diskUsedPercentage: 0, diskFree: 0 },
		time: "",
	},
};

interface Props {
	appName: string;
	appType?: "application" | "stack" | "docker-compose";
	serviceId?: string;
	// Which kind of service `serviceId` is; guessed when omitted.
	serviceKind?: ServiceKind;
	serverId?: string;
	// Inside a page that already has its title (the service Metrics page).
	embedded?: boolean;
}
export interface DockerStats {
	cpu: {
		value: string;
		time: string;
	};
	memory: {
		value: {
			used: number;
			total: number;
		};
		time: string;
	};
	block: {
		value: {
			readMb: number;
			writeMb: number;
		};
		time: string;
	};
	network: {
		value: {
			inputMb: number;
			outputMb: number;
		};
		time: string;
	};
	disk: {
		value: {
			diskTotal: number;
			diskUsage: number;
			diskUsedPercentage: number;
			diskFree: number;
		};

		time: string;
	};
}

export type DockerStatsJSON = {
	cpu: DockerStats["cpu"][];
	memory: DockerStats["memory"][];
	block: DockerStats["block"][];
	network: DockerStats["network"][];
	disk: DockerStats["disk"][];
};

export const convertMemoryToBytes = (
	memoryString: string | undefined,
): number => {
	if (!memoryString || typeof memoryString !== "string") {
		return 0;
	}

	const value = Number.parseFloat(memoryString) || 0;
	const unit = memoryString.replace(/[0-9.]/g, "").trim();

	switch (unit) {
		case "KiB":
			return value * 1024;
		case "MiB":
			return value * 1024 * 1024;
		case "GiB":
			return value * 1024 * 1024 * 1024;
		case "TiB":
			return value * 1024 * 1024 * 1024 * 1024;
		default:
			return value;
	}
};

// Room for the stored readings (288 per app) plus the live tail.
const MAX_DATA_POINTS = 300;

const SYNC_ID = "container-usage";
// Readings are kept every 10 s and arrive every 2 s while the page is open.
// Going by the faster pace would turn the kept ones into single dots.
const GAP_MS = 30_000;
// "1000 MiB": the plots start at the same place.
const TICK_CHARS = 8;

const CPU: MetricSeries<"cpu">[] = [{ key: "cpu", label: "CPU" }];
const MEMORY: MetricSeries<"memory">[] = [{ key: "memory", label: "Memory" }];
const DISK: MetricSeries<"disk">[] = [{ key: "disk", label: "Disk" }];
const BLOCK: MetricSeries<"read" | "write">[] = [
	{ key: "read", label: "Read" },
	{ key: "write", label: "Write", muted: true },
];
const NETWORK: MetricSeries<"netIn" | "netOut">[] = [
	{ key: "netIn", label: "In" },
	{ key: "netOut", label: "Out", muted: true },
];

const formatPercent = (value: number) =>
	`${value > 0 && value < 10 ? value.toFixed(1) : Math.round(value)}%`;

// Docker counts memory in binary units, as the heading above the chart does.
const formatMemory = (bytes: number) => {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
	return `${(bytes / 1024).toFixed(0)} KiB`;
};

const memoryAxis = (peak: number) => {
	const unit = peak >= 1024 ** 3 ? "GiB" : peak >= 1024 ** 2 ? "MiB" : "KiB";
	const size = { GiB: 1024 ** 3, MiB: 1024 ** 2, KiB: 1024 }[unit];
	return {
		tickUnit: size,
		floor: size,
		formatTick: (value: number) =>
			value === 0 ? "0" : `${Number((value / size).toPrecision(3))} ${unit}`,
	};
};

// Totals since the container started, in MB.
const totalAxis = (peak: number) => {
	const inGb = peak >= 1000;
	const size = inGb ? 1000 : 1;
	return {
		tickUnit: size,
		floor: size,
		formatTick: (value: number) =>
			value === 0
				? "0"
				: `${Number((value / size).toPrecision(3))} ${inGb ? "GB" : "MB"}`,
	};
};

const emptyStats: DockerStatsJSON = {
	cpu: [],
	memory: [],
	block: [],
	network: [],
	disk: [],
};

export const ContainerFreeMonitoring = ({
	appName,
	appType = "application",
	serviceId,
	serviceKind,
	serverId,
	embedded = false,
}: Props) => {
	const isHost = appName === HOST_APP_NAME;
	const { scope, kind, onError } = useServiceScope({
		serviceId: isHost ? undefined : serviceId,
		serviceKind,
		appType,
		serverId,
	});
	const [liveData, setLiveData] = useState<DockerStatsJSON>(emptyStats);
	const [currentData, setCurrentData] = useState<DockerStats>(defaultData);
	const currentRef = useRef<DockerStats>(defaultData);

	useEffect(() => {
		currentRef.current = defaultData;
		setCurrentData(defaultData);
		setLiveData(emptyStats);
	}, [appName]);

	const request: LiveRequest | null = !appName
		? null
		: {
				kind: "containerStats",
				scope,
				target: isHost
					? { type: "host" }
					: kind === "compose"
						? { type: "container", containerId: appName }
						: { type: "service", serviceName: appName },
			};

	// What earlier visits recorded, followed by the readings of this session.
	const history = useQueryResult(
		api.live.monitoringHistory.history,
		request ? { request } : "skip",
	);
	const accumulativeData = useMemo<DockerStatsJSON>(() => {
		const rows = Array.isArray(history) ? history : [];
		const firstLive = liveData.cpu[0]?.time;
		const earlier = rows.filter(
			(row) => !firstLive || new Date(row.at).toISOString() < firstLive,
		);
		const past = (pick: (row: (typeof rows)[number]) => unknown) =>
			earlier.map((row) => ({
				value: pick(row),
				time: new Date(row.at).toISOString(),
			}));
		const join = <T,>(older: unknown[], newer: T[]) =>
			[...(older as T[]), ...newer].slice(-MAX_DATA_POINTS);
		return {
			cpu: join(
				past((row) => row.sample.cpu),
				liveData.cpu,
			),
			memory: join(
				past((row) => row.sample.memory),
				liveData.memory,
			),
			block: join(
				past((row) => row.sample.block),
				liveData.block,
			),
			network: join(
				past((row) => row.sample.network),
				liveData.network,
			),
			disk: join(
				past((row) => row.sample.disk ?? defaultData.disk.value),
				liveData.disk,
			),
		};
	}, [history, liveData]);

	const { error } = useLiveData(request, (value) => {
		if (!value) return;
		const time = new Date().toISOString();
		const sample = isHostStats(value)
			? statsFromHost(value)
			: statsFromContainer(value as Record<string, string>, time);

		const previous = currentRef.current;
		const data: DockerStats = {
			cpu: sample.cpu,
			// Docker reports memory as unit strings ("12MiB"); the charts read
			// them through convertMemoryToBytes.
			memory: sample.memory as unknown as DockerStats["memory"],
			block: sample.block,
			disk:
				"disk" in sample ? (sample.disk as DockerStats["disk"]) : previous.disk,
			network: sample.network,
		};
		currentRef.current = data;
		setCurrentData(data);

		setLiveData((prevData) => ({
			cpu: [...prevData.cpu, data.cpu].slice(-MAX_DATA_POINTS),
			memory: [...prevData.memory, data.memory].slice(-MAX_DATA_POINTS),
			block: [...prevData.block, data.block].slice(-MAX_DATA_POINTS),
			network: [...prevData.network, data.network].slice(-MAX_DATA_POINTS),
			disk: [...prevData.disk, data.disk].slice(-MAX_DATA_POINTS),
		}));
	});

	useEffect(() => {
		if (!error || onError(error)) return;
		toast.error(error);
	}, [error]);

	return (
		<div className="flex flex-col gap-4">
			{!embedded && (
				<header className="flex flex-col gap-1">
					<h2 className="font-semibold text-[15px]">Monitoring</h2>
					<p className="text-muted-foreground text-sm">
						Live usage of this container.
					</p>
				</header>
			)}

			<ContainerUsageCharts
				stats={accumulativeData}
				current={currentData}
				isHost={isHost}
				serverId={serverId}
			/>
		</div>
	);
};

/** The usage charts of one container, or of the host itself. */
export function ContainerUsageCharts({
	stats,
	current,
	isHost,
	serverId,
}: {
	stats: DockerStatsJSON;
	current: DockerStats;
	isHost: boolean;
	serverId?: string;
}) {
	const readings = useMemo(
		() =>
			stats.cpu.map((cpu, index) => ({
				time: new Date(cpu.time).getTime(),
				cpu: Number.parseFloat(String(cpu.value)) || 0,
				memory: convertMemoryToBytes(
					stats.memory[index]?.value.used as unknown as string,
				),
				disk: stats.disk[index]?.value.diskUsage ?? null,
				read: stats.block[index]?.value.readMb ?? null,
				write: stats.block[index]?.value.writeMb ?? null,
				netIn: stats.network[index]?.value.inputMb ?? null,
				netOut: stats.network[index]?.value.outputMb ?? null,
			})),
		[stats],
	);
	const peak = (pick: (reading: (typeof readings)[number]) => number) =>
		readings.reduce((top, reading) => Math.max(top, pick(reading)), 0);

	const cpu = String(current.cpu.value ?? "0%");
	// Docker reports memory as unit strings ("12MiB") in live samples.
	const memoryUsed = current.memory.value.used as unknown as string;
	const memoryTotal = current.memory.value.total as unknown as string;
	const memoryLimitBytes = convertMemoryToBytes(memoryTotal);

	return (
		<div className="grid gap-4 lg:grid-cols-2">
			<ChartPanel title="CPU" value={cpu}>
				<Progress
					value={Number.parseInt(cpu.replace("%", ""), 10)}
					className="w-full"
				/>
				<MetricChart
					label="CPU use"
					readings={readings}
					series={CPU}
					floor={100}
					formatValue={formatPercent}
					formatTick={(value) => `${Math.round(value)}%`}
					tickChars={TICK_CHARS}
					gapMs={GAP_MS}
					syncId={SYNC_ID}
				/>
			</ChartPanel>
			<ChartPanel
				title="Memory"
				value={`${memoryUsed || 0} of ${memoryTotal || 0}`}
			>
				<Progress
					value={
						memoryLimitBytes
							? (convertMemoryToBytes(memoryUsed) / memoryLimitBytes) * 100
							: 0
					}
					className="w-full"
				/>
				<MetricChart
					label="Memory use"
					readings={readings}
					series={MEMORY}
					{...memoryAxis(
						isHost ? memoryLimitBytes : peak((reading) => reading.memory),
					)}
					// The host's memory is a real ceiling; a container without a
					// limit reports the host's too, which would flatten its line.
					max={isHost ? memoryLimitBytes || undefined : undefined}
					formatValue={formatMemory}
					tickChars={TICK_CHARS}
					gapMs={GAP_MS}
					syncId={SYNC_ID}
				/>
			</ChartPanel>
			{isHost && (
				<ChartPanel
					title="Disk space"
					value={`${current.disk.value.diskUsage} GB of ${current.disk.value.diskTotal} GB`}
				>
					<Progress
						value={current.disk.value.diskUsedPercentage}
						className="w-full"
					/>
					<MetricChart
						label="Disk space used"
						readings={readings}
						series={DISK}
						max={current.disk.value.diskTotal || undefined}
						formatValue={(value) => `${value.toFixed(1)} GB`}
						formatTick={(value) =>
							value === 0 ? "0" : `${Math.round(value)} GB`
						}
						tickChars={TICK_CHARS}
						gapMs={GAP_MS}
						syncId={SYNC_ID}
					/>
				</ChartPanel>
			)}
			{isHost && (
				<ChartPanel title="Docker disk usage">
					<DockerDiskUsageChart serverId={serverId} />
				</ChartPanel>
			)}
			<ChartPanel
				title="Block I/O"
				value={`read ${formatMb(current.block.value.readMb)} · write ${formatMb(current.block.value.writeMb)}`}
			>
				<MetricChart
					label="Block reads and writes"
					readings={readings}
					series={BLOCK}
					{...totalAxis(
						peak((reading) => Math.max(reading.read ?? 0, reading.write ?? 0)),
					)}
					formatValue={formatMb}
					tickChars={TICK_CHARS}
					gapMs={GAP_MS}
					syncId={SYNC_ID}
				/>
				<MetricLegend series={BLOCK} />
			</ChartPanel>
			<ChartPanel
				title="Network I/O"
				value={`in ${formatMb(current.network.value.inputMb)} · out ${formatMb(current.network.value.outputMb)}`}
			>
				<MetricChart
					label="Network in and out"
					readings={readings}
					series={NETWORK}
					{...totalAxis(
						peak((reading) =>
							Math.max(reading.netIn ?? 0, reading.netOut ?? 0),
						),
					)}
					formatValue={formatMb}
					tickChars={TICK_CHARS}
					gapMs={GAP_MS}
					syncId={SYNC_ID}
				/>
				<MetricLegend series={NETWORK} />
			</ChartPanel>
		</div>
	);
}

/** One chart on its hairline surface: what it measures, the current value. */
function ChartPanel({
	title,
	value,
	children,
}: {
	title: string;
	value?: string;
	children: React.ReactNode;
}) {
	return (
		<section className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4">
			<div className="flex items-baseline justify-between gap-3">
				<h3 className="font-medium text-sm">{title}</h3>
				{value ? (
					<span className="truncate text-muted-foreground text-sm tabular-nums">
						{value}
					</span>
				) : null}
			</div>
			{children}
		</section>
	);
}
