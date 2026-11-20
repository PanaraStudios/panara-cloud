"use client";

import { api } from "@panara-cloud/backend/api";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
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
import { DockerBlockChart } from "./docker-block-chart";
import { DockerCpuChart } from "./docker-cpu-chart";
import { DockerDiskChart } from "./docker-disk-chart";
import { DockerDiskUsageChart } from "./docker-disk-usage-chart";
import { DockerMemoryChart } from "./docker-memory-chart";
import { DockerNetworkChart } from "./docker-network-chart";

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

	const cpu = String(currentData.cpu.value ?? "0%");
	// Docker reports memory as unit strings ("12MiB") in live samples.
	const memoryUsed = currentData.memory.value.used as unknown as string;
	const memoryTotal = currentData.memory.value.total as unknown as string;
	const memoryLimitBytes = convertMemoryToBytes(memoryTotal);

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

			<div className="grid gap-4 lg:grid-cols-2">
				<ChartPanel title="CPU" value={cpu}>
					<Progress
						value={Number.parseInt(cpu.replace("%", ""), 10)}
						className="w-full"
					/>
					<DockerCpuChart accumulativeData={accumulativeData.cpu} />
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
					<DockerMemoryChart
						accumulativeData={accumulativeData.memory}
						memoryLimitGB={memoryLimitBytes / 1024 ** 3}
					/>
				</ChartPanel>
				{isHost && (
					<ChartPanel
						title="Disk space"
						value={`${currentData.disk.value.diskUsage} GB of ${currentData.disk.value.diskTotal} GB`}
					>
						<Progress
							value={currentData.disk.value.diskUsedPercentage}
							className="w-full"
						/>
						<DockerDiskChart
							accumulativeData={accumulativeData.disk}
							diskTotal={currentData.disk.value.diskTotal}
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
					value={`read ${formatMb(currentData.block.value.readMb)} · write ${formatMb(currentData.block.value.writeMb)}`}
				>
					<DockerBlockChart accumulativeData={accumulativeData.block} />
				</ChartPanel>
				<ChartPanel
					title="Network I/O"
					value={`in ${formatMb(currentData.network.value.inputMb)} · out ${formatMb(currentData.network.value.outputMb)}`}
				>
					<DockerNetworkChart accumulativeData={accumulativeData.network} />
				</ChartPanel>
			</div>
		</div>
	);
};

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
