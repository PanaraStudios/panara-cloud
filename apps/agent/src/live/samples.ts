// Stats readings in the shape the free monitoring charts read (and the
// backend stores as history).
export type MonitoringSample = {
	cpu: string;
	memory: { used: string; total: string };
	block: { readMb: number; writeMb: number };
	network: { inputMb: number; outputMb: number };
	disk?: {
		diskTotal: number;
		diskUsage: number;
		diskUsedPercentage: number;
		diskFree: number;
	};
};

export type DockerStatsRow = {
	BlockIO?: string;
	CPUPerc?: string;
	MemUsage?: string;
	NetIO?: string;
};

export type HostStats = {
	cpuPercent: number | null;
	memoryTotal: number;
	memoryUsed: number;
	diskTotal: number | null;
	diskUsed: number | null;
	blockReadBytes: number;
	blockWriteBytes: number;
	netInBytes: number;
	netOutBytes: number;
};

const IO_UNIT_FACTORS: Record<string, number> = {
	B: 1 / 1e6,
	kB: 1e-3,
	KB: 1e-3,
	MB: 1,
	GB: 1e3,
	TB: 1e6,
	KiB: 1024 / 1e6,
	MiB: 1024 ** 2 / 1e6,
	GiB: 1024 ** 3 / 1e6,
	TiB: 1024 ** 4 / 1e6,
};

// A docker stats I/O size in MB ("1.5kB" -> 0.0015).
export const parseIoToMb = (raw: string | undefined): number => {
	if (!raw) return 0;
	const parsed = Number.parseFloat(raw);
	if (Number.isNaN(parsed)) return 0;
	const unit = raw.replace(/[0-9.\s]/g, "");
	return Number((parsed * (IO_UNIT_FACTORS[unit] ?? 1)).toFixed(6));
};

const pair = (value: string | undefined) => {
	const [left, , right] = (value ?? "").split(" ");
	return [left ?? "", right ?? ""] as const;
};

const MB = 1e6;
const GIB = 1024 ** 3;
const GB = 1e9;
const round = (value: number, digits: number) => Number(value.toFixed(digits));

export const sampleFromContainer = (row: DockerStatsRow): MonitoringSample => {
	const [used, total] = pair(row.MemUsage);
	const [read, write] = pair(row.BlockIO);
	const [input, output] = pair(row.NetIO);
	return {
		cpu: row.CPUPerc || "0%",
		memory: { used, total },
		block: { readMb: parseIoToMb(read), writeMb: parseIoToMb(write) },
		network: { inputMb: parseIoToMb(input), outputMb: parseIoToMb(output) },
	};
};

export const sampleFromHost = (stats: HostStats): MonitoringSample => {
	const diskTotal = (stats.diskTotal ?? 0) / GB;
	const diskUsage = (stats.diskUsed ?? 0) / GB;
	return {
		cpu: `${(stats.cpuPercent ?? 0).toFixed(2)}%`,
		memory: {
			used: `${(stats.memoryUsed / GIB).toFixed(2)}GiB`,
			total: `${(stats.memoryTotal / GIB).toFixed(2)}GiB`,
		},
		block: {
			readMb: round(stats.blockReadBytes / MB, 6),
			writeMb: round(stats.blockWriteBytes / MB, 6),
		},
		network: {
			inputMb: round(stats.netInBytes / MB, 6),
			outputMb: round(stats.netOutBytes / MB, 6),
		},
		disk: {
			diskTotal: round(diskTotal, 2),
			diskUsage: round(diskUsage, 2),
			diskUsedPercentage: diskTotal
				? round((diskUsage / diskTotal) * 100, 2)
				: 0,
			diskFree: round(diskTotal - diskUsage, 2),
		},
	};
};
