"use client";

import type { Id } from "@panara-cloud/backend/dataModel";
import { useEffect, useState } from "react";
import { type LiveMessage, type LiveRequest, useLiveSession } from "@/lib/live";
import { useOrganization } from "@/lib/organization";
import { parseIoToMb } from "@/lib/shared/monitoring-units";

export type ServiceKind = "application" | "compose" | "database";

// What the panel host's own monitoring passes as appName: host-wide CPU,
// memory and disk instead of one container.
export const HOST_APP_NAME = "panara-cloud";

type DockerStatsRow = {
	BlockIO?: string;
	CPUPerc?: string;
	MemUsage?: string;
	NetIO?: string;
};

type HostStats = {
	cpuPercent: number | null;
	memoryTotal: number;
	memoryUsed: number;
	diskTotal: number | null;
	diskUsed: number | null;
	// Cumulative since boot.
	blockReadBytes?: number;
	blockWriteBytes?: number;
	netInBytes?: number;
	netOutBytes?: number;
	timestamp: string;
};

const GIB = 1024 ** 3;
const GB = 1e9;

const split = (value: string | undefined) => {
	const [left, , right] = (value ?? "").split(" ");
	return [left ?? "", right ?? ""] as const;
};

// One `docker stats` row as the free monitoring charts expect it.
export const statsFromContainer = (row: DockerStatsRow, time: string) => {
	const [used, total] = split(row.MemUsage);
	const [read, write] = split(row.BlockIO);
	const [input, output] = split(row.NetIO);
	return {
		cpu: { value: row.CPUPerc ?? "0%", time },
		memory: { value: { used, total }, time },
		block: {
			value: { readMb: parseIoToMb(read), writeMb: parseIoToMb(write) },
			time,
		},
		network: {
			value: { inputMb: parseIoToMb(input), outputMb: parseIoToMb(output) },
			time,
		},
	};
};

const MB = 1e6;

// The panel host's own entry: CPU, memory, disk and the host's block and
// network I/O.
export const statsFromHost = (stats: HostStats) => {
	const time = stats.timestamp;
	const diskTotal = (stats.diskTotal ?? 0) / GB;
	const diskUsage = (stats.diskUsed ?? 0) / GB;
	return {
		cpu: { value: `${(stats.cpuPercent ?? 0).toFixed(2)}%`, time },
		memory: {
			value: {
				used: `${(stats.memoryUsed / GIB).toFixed(2)}GiB`,
				total: `${(stats.memoryTotal / GIB).toFixed(2)}GiB`,
			},
			time,
		},
		block: {
			value: {
				readMb: (stats.blockReadBytes ?? 0) / MB,
				writeMb: (stats.blockWriteBytes ?? 0) / MB,
			},
			time,
		},
		network: {
			value: {
				inputMb: (stats.netInBytes ?? 0) / MB,
				outputMb: (stats.netOutBytes ?? 0) / MB,
			},
			time,
		},
		disk: {
			value: {
				diskTotal: +diskTotal.toFixed(2),
				diskUsage: +diskUsage.toFixed(2),
				diskUsedPercentage: diskTotal
					? +((diskUsage / diskTotal) * 100).toFixed(2)
					: 0,
				diskFree: +(diskTotal - diskUsage).toFixed(2),
			},
			time,
		},
	};
};

export const isHostStats = (data: unknown): data is HostStats =>
	typeof data === "object" && data !== null && "memoryTotal" in data;

const SERVICE_NOT_FOUND = "Service not found";

// The live scope a monitoring widget runs in. Without a kind, a service id
// is tried as an application and then as a database: some widgets only
// receive the service id.
export function useServiceScope(input: {
	serviceId?: string;
	serviceKind?: ServiceKind;
	appType?: string;
	serverId?: string;
}) {
	const { active } = useOrganization();
	const guessed: ServiceKind =
		input.appType === "stack" || input.appType === "docker-compose"
			? "compose"
			: "application";
	const [fallback, setFallback] = useState<ServiceKind | null>(null);
	useEffect(() => setFallback(null), [input.serviceId]);
	const kind = input.serviceKind ?? fallback ?? guessed;
	const scope: Extract<LiveRequest, { kind: "metrics" }>["scope"] =
		input.serviceId
			? { type: "service", serviceKind: kind, serviceId: input.serviceId }
			: {
					type: "host",
					organizationId: active.id,
					serverId: input.serverId as Id<"servers"> | undefined,
				};
	const willFallback = (error: string | null) =>
		!!error?.includes(SERVICE_NOT_FOUND) &&
		!input.serviceKind &&
		kind === "application";
	// Call from an effect; true when the error only means "try a database".
	const onError = (error: string | null) => {
		if (!willFallback(error)) return false;
		setFallback("database");
		return true;
	};
	return { scope, kind, onError, willFallback };
}

// A live session that hands every `stats`/`metrics` payload to `onData`.
export function useLiveData(
	request: LiveRequest | null,
	onData: (data: unknown) => void,
) {
	return useLiveSession(request, (message: LiveMessage) => {
		if (message.type === "stats" || message.type === "metrics") {
			onData(message.data);
		}
	});
}
