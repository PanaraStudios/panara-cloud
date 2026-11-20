import { quote } from "../lib/shell";
import type { LiveConnection, LiveProcess } from "./connection";
import {
	assertContainerAccess,
	assertSwarmAccess,
	containerIdentity,
	labelFilters,
} from "./ownership";
import { CLOSE, type RequestOf, type Restriction } from "./protocol";
import {
	type DockerStatsRow,
	type MonitoringSample,
	sampleFromContainer,
	sampleFromHost,
} from "./samples";
import {
	errorMessage,
	type SessionContext,
	type SessionHandler,
	stripCr,
	textForwarder,
} from "./session";

const STATS_INTERVAL_MS = 2000;
// Wide enough that the PTY never wraps long log lines.
const STREAM_PTY = { cols: 1000, rows: 50 };

export const logsCommand = (request: RequestOf<"containerLogs">) => {
	const swarm = request.runType === "swarm";
	const parts = [
		"docker",
		swarm ? "service" : "container",
		"logs",
		...(request.timestamps ? ["--timestamps"] : []),
		...(swarm ? ["--raw"] : []),
		`--tail ${request.tail}`,
		...(request.since === "all" ? [] : [`--since ${quote(request.since)}`]),
		"--follow",
		quote(request.containerId),
		"2>&1",
	];
	const base = parts.join(" ");
	return request.search
		? `${base} | grep --line-buffered -iF -- ${quote(request.search)}`
		: base;
};

// Runs a long-lived command (with a PTY over SSH so it dies with the channel)
// and forwards its output as text.
const streamCommand = async (
	ctx: SessionContext,
	command: string,
	emit: (text: string) => void,
): Promise<SessionHandler> => {
	const proc: LiveProcess = await ctx.conn.spawn(command, {
		pty: ctx.conn.kind === "ssh" ? STREAM_PTY : undefined,
	});
	const forward = textForwarder(emit, stripCr);
	proc.on("stdout", forward);
	proc.on("stderr", forward);
	proc.once("exit", (code: number | null) => {
		ctx.send({ type: "exit", code });
		ctx.close(CLOSE.ended, "Stream ended");
	});
	return { dispose: () => proc.kill() };
};

// The ready frame carries the container's (or swarm service's) name, for
// naming a log download.
export const startLogs = async (
	ctx: SessionContext,
): Promise<SessionHandler> => {
	const request = ctx.redeemed.request as RequestOf<"containerLogs">;
	let name: string;
	if (request.runType === "swarm") {
		name = await assertSwarmAccess(
			ctx.conn,
			request.containerId,
			ctx.redeemed.restriction,
		);
	} else {
		name = (
			await containerIdentity(
				ctx.conn,
				request.containerId,
				ctx.redeemed.restriction,
			)
		).name;
	}
	const handler = await streamCommand(ctx, logsCommand(request), (data) =>
		ctx.send({ type: "data", data }),
	);
	return { ...handler, info: { name } };
};

// With `sinceMinutes`, Docker replays that window before following new
// events.
export const eventsCommand = (
	restriction: Restriction,
	sinceMinutes?: number,
	now = Date.now(),
) =>
	[
		"docker events --format '{{json .}}'",
		...(sinceMinutes
			? [`--since ${Math.floor(now / 1000) - sinceMinutes * 60}`]
			: []),
		...labelFilters(restriction).map((f) => `--filter ${quote(f)}`),
	].join(" ");

export const startEvents = async (
	ctx: SessionContext,
): Promise<SessionHandler> => {
	const request = ctx.redeemed.request as RequestOf<"dockerEvents">;
	let pending = "";
	return await streamCommand(
		ctx,
		eventsCommand(ctx.redeemed.restriction, request.sinceMinutes),
		(text) => {
			pending += text;
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					ctx.send({ type: "event", data: JSON.parse(line) });
				} catch {
					ctx.send({ type: "data", data: `${line}\n` });
				}
			}
		},
	);
};

type CpuSample = { idle: number; total: number };

// Cumulative bytes over every interface except loopback (/proc/net/dev).
export const parseNetDev = (text: string) => {
	let received = 0;
	let sent = 0;
	for (const line of text.split("\n")) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		if (line.slice(0, colon).trim() === "lo") continue;
		const fields = line
			.slice(colon + 1)
			.trim()
			.split(/\s+/)
			.map(Number);
		received += Number.isFinite(fields[0]) ? (fields[0] as number) : 0;
		sent += Number.isFinite(fields[8]) ? (fields[8] as number) : 0;
	}
	return { received, sent };
};

// Physical disks only: partitions, loop/ram and md/dm devices repeat I/O
// already counted on the underlying disk.
const NON_PHYSICAL_DEVICE_PATTERNS = [
	/^(loop|ram|zram)/,
	/^(sr|fd)\d+$/,
	/^(sd|hd|vd|xvd)[a-z]+\d+$/,
	/^(nvme\d+n\d+|mmcblk\d+)p\d+$/,
	/^(md|dm-)/,
];

export const isPhysicalDisk = (device: string) =>
	!NON_PHYSICAL_DEVICE_PATTERNS.some((pattern) => pattern.test(device));

const SECTOR_BYTES = 512;

// Cumulative bytes read/written by physical disks (/proc/diskstats).
export const parseDiskStats = (text: string) => {
	let read = 0;
	let write = 0;
	for (const line of text.split("\n")) {
		const fields = line.trim().split(/\s+/);
		const device = fields[2];
		if (!device || !isPhysicalDisk(device)) continue;
		const sectorsRead = Number(fields[5]);
		const sectorsWritten = Number(fields[9]);
		if (Number.isFinite(sectorsRead)) read += sectorsRead * SECTOR_BYTES;
		if (Number.isFinite(sectorsWritten)) write += sectorsWritten * SECTOR_BYTES;
	}
	return { read, write };
};

export const parseHostStats = (text: string, previous: CpuSample | null) => {
	const sections = text.split("\n---\n");
	const cpuLine = (sections[0] ?? "").trim().split(/\s+/).slice(1).map(Number);
	const idle = (cpuLine[3] ?? 0) + (cpuLine[4] ?? 0);
	const total = cpuLine.reduce(
		(sum, n) => sum + (Number.isFinite(n) ? n : 0),
		0,
	);
	const sample = { idle, total };
	const cpu =
		previous && total > previous.total
			? 100 * (1 - (idle - previous.idle) / (total - previous.total))
			: null;
	const mem: Record<string, number> = {};
	for (const line of (sections[1] ?? "").split("\n")) {
		const match = /^(\w+):\s+(\d+)/.exec(line);
		if (match?.[1] && match[2]) mem[match[1]] = Number(match[2]) * 1024;
	}
	const disk = (sections[2] ?? "").trim().split("\n")[1]?.trim().split(/\s+/);
	const load = (sections[3] ?? "").trim().split(/\s+/).slice(0, 3).map(Number);
	const network = parseNetDev(sections[4] ?? "");
	const block = parseDiskStats(sections[5] ?? "");
	const memTotal = mem.MemTotal ?? 0;
	const memUsed = memTotal - (mem.MemAvailable ?? mem.MemFree ?? 0);
	return {
		sample,
		stats: {
			cpuPercent: cpu === null ? null : Math.round(cpu * 100) / 100,
			memoryTotal: memTotal,
			memoryUsed: memUsed,
			memoryPercent: memTotal
				? Math.round((memUsed / memTotal) * 10000) / 100
				: null,
			diskTotal: disk ? Number(disk[1]) * 1024 : null,
			diskUsed: disk ? Number(disk[2]) * 1024 : null,
			load,
			blockReadBytes: block.read,
			blockWriteBytes: block.write,
			netInBytes: network.received,
			netOutBytes: network.sent,
			timestamp: new Date().toISOString(),
		},
	};
};

const HOST_STATS_COMMAND =
	"head -n1 /proc/stat; echo ---; cat /proc/meminfo; echo ---; df -kP / ; echo ---; cat /proc/loadavg; echo ---; cat /proc/net/dev; echo ---; cat /proc/diskstats";

// `docker stats` of every running container `restriction` allows; empty
// output when none run.
export const allStatsCommand = (restriction: Restriction) => {
	const filters = labelFilters(restriction)
		.map((f) => `--filter ${quote(f)}`)
		.join(" ");
	return `ids=$(docker ps -q${filters ? ` ${filters}` : ""}); [ -z "$ids" ] || docker stats --no-stream --format '{{json .}}' $ids`;
};

export const parseStatsLines = (output: string): unknown[] =>
	output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("{"))
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as unknown];
			} catch {
				return [];
			}
		});

export const HISTORY_INTERVAL_MS = 15_000;

// Hands at most one reading per HISTORY_INTERVAL_MS to the backend's
// monitoring history; failures only cost history, never the stream.
export const historyRecorder = (
	ctx: Pick<SessionContext, "redeemed" | "services" | "log">,
	now: () => number = Date.now,
) => {
	let last = 0;
	let inFlight = false;
	return (sample: MonitoringSample) => {
		const recordStats = ctx.services.recordStats;
		if (!recordStats || inFlight || now() - last < HISTORY_INTERVAL_MS) return;
		last = now();
		inFlight = true;
		recordStats(ctx.redeemed.sessionId, sample)
			.catch((error) =>
				ctx.log(`Could not record monitoring history: ${errorMessage(error)}`),
			)
			.finally(() => {
				inFlight = false;
			});
	};
};

const findServiceContainer = async (conn: LiveConnection, service: string) => {
	const out = await conn.runOk(
		`docker ps -q --no-trunc --filter ${quote(`label=com.docker.swarm.service.name=${service}`)} --filter status=running`,
	);
	return out.trim().split("\n")[0] || null;
};

export const startStats = async (
	ctx: SessionContext,
): Promise<SessionHandler> => {
	const request = ctx.redeemed.request as RequestOf<"containerStats">;
	const { target } = request;
	let containerId: string | null = null;
	if (target.type === "container") {
		containerId = await assertContainerAccess(
			ctx.conn,
			target.containerId,
			ctx.redeemed.restriction,
		);
	}
	let stopped = false;
	let previous: CpuSample | null = null;
	const record = historyRecorder(ctx);
	const tick = async () => {
		if (target.type === "host") {
			const parsed = parseHostStats(
				await ctx.conn.runOk(HOST_STATS_COMMAND),
				previous,
			);
			previous = parsed.sample;
			ctx.send({ type: "stats", data: parsed.stats });
			if (parsed.stats.cpuPercent !== null) {
				record(sampleFromHost(parsed.stats));
			}
			return;
		}
		if (target.type === "all") {
			const out = await ctx.conn.runOk(
				allStatsCommand(ctx.redeemed.restriction),
			);
			ctx.send({ type: "stats", data: parseStatsLines(out) });
			return;
		}
		if (target.type === "service") {
			const found = await findServiceContainer(ctx.conn, target.serviceName);
			if (!found) {
				ctx.close(CLOSE.notFound, "Container not running");
				stopped = true;
				return;
			}
			if (found !== containerId) {
				containerId = await assertContainerAccess(
					ctx.conn,
					found,
					ctx.redeemed.restriction,
				);
			}
		}
		const out = await ctx.conn.runOk(
			`docker stats --no-stream --format '{{json .}}' ${quote(containerId ?? "")}`,
		);
		const row = JSON.parse(
			out.trim().split("\n")[0] ?? "null",
		) as DockerStatsRow | null;
		ctx.send({ type: "stats", data: row });
		if (row) record(sampleFromContainer(row));
	};
	const loop = async () => {
		while (!stopped) {
			try {
				await tick();
			} catch (error) {
				if (stopped) return;
				ctx.close(CLOSE.internal, errorMessage(error).slice(0, 120));
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, STATS_INTERVAL_MS));
		}
	};
	void loop();
	return {
		dispose: () => {
			stopped = true;
		},
	};
};
