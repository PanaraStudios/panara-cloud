"use client";

import { api } from "@panara-cloud/backend/api";
import { useEffect, useMemo, useRef, useState } from "react";
import { convertMemoryToBytes } from "@/components/dashboard/monitoring/free/container/show-free-container-monitoring";
import {
	isHostStats,
	statsFromContainer,
	statsFromHost,
	useLiveData,
	useServiceScope,
} from "@/components/dashboard/monitoring/live-stats";
import { errorMessage } from "@/lib/auth/errors";
import { useQueryResult } from "@/lib/host-data";
import type { LiveRequest } from "@/lib/live";
import { cn } from "@/lib/utils";
import type { ServiceInfo } from "./service-context";

/** One reading, with I/O as rates (MB/s) between consecutive samples. */
export type StatPoint = {
	at: number;
	cpu: number;
	memory: number;
	memoryLimit: number;
	netIn: number;
	netOut: number;
	read: number;
	write: number;
};

type RawSample = {
	at: number;
	cpu: string;
	memory: { used: string; total: string };
	network: { inputMb: number; outputMb: number };
	block: { readMb: number; writeMb: number };
};

const MAX_POINTS = 600;
/** Waits before the live session is opened again, one per try. */
const REOPEN_DELAYS_MS = [2000, 4000, 8000, 15_000, 30_000];

function toPoints(samples: RawSample[]): StatPoint[] {
	const points: StatPoint[] = [];
	samples.forEach((sample, i) => {
		const previous = samples[i - 1];
		const seconds = previous ? (sample.at - previous.at) / 1000 : 0;
		// Docker reports cumulative I/O; a restart resets it (negative delta).
		const rate = (now: number, before: number | undefined) =>
			previous && seconds > 0 && before !== undefined && now >= before
				? (now - before) / seconds
				: 0;
		points.push({
			at: sample.at,
			cpu: Number.parseFloat(String(sample.cpu).replace("%", "")) || 0,
			memory: convertMemoryToBytes(sample.memory.used),
			memoryLimit: convertMemoryToBytes(sample.memory.total),
			netIn: rate(sample.network.inputMb, previous?.network.inputMb),
			netOut: rate(sample.network.outputMb, previous?.network.outputMb),
			read: rate(sample.block.readMb, previous?.block.readMb),
			write: rate(sample.block.writeMb, previous?.block.writeMb),
		});
	});
	// The first reading has no previous one to take a rate from.
	const [head, next] = points;
	if (head && next) {
		Object.assign(head, {
			netIn: next.netIn,
			netOut: next.netOut,
			read: next.read,
			write: next.write,
		});
	}
	return points;
}

/** The service's container stats: the stored history (about the last 48
    minutes), plus live readings while `live` is on. */
export function useServiceStats(
	service: ServiceInfo,
	{ live = false, enabled = true }: { live?: boolean; enabled?: boolean } = {},
) {
	const { scope } = useServiceScope({
		serviceId: service.id,
		serviceKind: service.family,
		serverId: service.serverId ?? undefined,
	});
	const request: LiveRequest | null =
		enabled && service.family !== "compose"
			? {
					kind: "containerStats",
					scope,
					target: { type: "service", serviceName: service.appName },
				}
			: null;
	const history = useQueryResult(
		api.live.monitoringHistory.history,
		request ? { request } : "skip",
	);
	const [liveSamples, setLiveSamples] = useState<RawSample[]>([]);
	const liveRef = useRef<RawSample[]>([]);
	// The agent ends the session when the service has no container to read: a
	// stop, or the moment between the two containers of a restart. Once the
	// service runs the session is opened again, a few times at most until a
	// reading arrives.
	const running = service.status === "done";
	const [held, setHeld] = useState(false);
	const reopens = useRef(0);
	const { error } = useLiveData(live && !held ? request : null, (value) => {
		if (!value) return;
		reopens.current = 0;
		const time = new Date().toISOString();
		const sample = isHostStats(value)
			? statsFromHost(value)
			: statsFromContainer(value as Record<string, string>, time);
		const next: RawSample = {
			at: Date.now(),
			cpu: String(sample.cpu.value),
			memory: sample.memory.value as unknown as RawSample["memory"],
			network: sample.network.value,
			block: sample.block.value,
		};
		liveRef.current = [...liveRef.current, next].slice(-MAX_POINTS);
		setLiveSamples(liveRef.current);
	});
	// A service that runs again starts the count over.
	useEffect(() => {
		if (running) reopens.current = 0;
	}, [running]);
	useEffect(() => {
		if (!live || !error || !running || held) return;
		if (reopens.current >= REOPEN_DELAYS_MS.length) return;
		reopens.current += 1;
		setHeld(true);
	}, [live, error, running, held]);
	useEffect(() => {
		if (!held) return;
		const timer = setTimeout(
			() => setHeld(false),
			REOPEN_DELAYS_MS[reopens.current - 1] ?? 30_000,
		);
		return () => clearTimeout(timer);
	}, [held]);
	const points = useMemo(() => {
		const rows = Array.isArray(history) ? history : [];
		const firstLive = liveSamples[0]?.at ?? Number.POSITIVE_INFINITY;
		const stored: RawSample[] = rows
			.filter((row) => row.at < firstLive)
			.map((row) => ({ at: row.at, ...row.sample }));
		return toPoints([...stored, ...liveSamples]);
	}, [history, liveSamples]);
	return {
		points,
		loading: history === undefined,
		error: history instanceof Error ? errorMessage(history) : error,
	};
}

export function formatBytes(bytes: number) {
	if (bytes >= 1024 ** 3)
		return {
			value: (bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, ""),
			unit: "GB",
		};
	if (bytes >= 1024 ** 2)
		return { value: Math.round(bytes / 1024 ** 2).toString(), unit: "MB" };
	if (bytes >= 1024)
		return { value: Math.round(bytes / 1024).toString(), unit: "KB" };
	return { value: Math.round(bytes).toString(), unit: "B" };
}

export function formatRate(mbPerSecond: number) {
	if (mbPerSecond >= 1) return `${mbPerSecond.toFixed(1)} MB/s`;
	if (mbPerSecond >= 0.001) return `${Math.round(mbPerSecond * 1000)} KB/s`;
	return "0 KB/s";
}

type Series = { values: number[]; muted?: boolean };

/** A plain SVG line chart: ink lines, hairline grid, optional markers. */
export function LineChart({
	series,
	max,
	height = 160,
	grid = true,
	limit,
	markers = [],
	className,
	label,
}: {
	series: Series[];
	max?: number;
	height?: number;
	grid?: boolean;
	/** A dashed line at this value (a memory limit). */
	limit?: number;
	/** Vertical dashed markers at fractions (0–1) of the width. */
	markers?: number[];
	className?: string;
	label: string;
}) {
	const width = 600;
	const top =
		max ??
		Math.max(limit ?? 0, ...series.flatMap((s) => s.values), Number.EPSILON) *
			1.15;
	const y = (value: number) => height - (value / top) * (height - 4) - 2;
	const path = (values: number[]) =>
		values
			.map((value, i) => {
				const x = values.length > 1 ? (i / (values.length - 1)) * width : 0;
				return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y(value).toFixed(1)}`;
			})
			.join(" ");
	return (
		<svg
			viewBox={`0 0 ${width} ${height}`}
			preserveAspectRatio="none"
			role="img"
			aria-label={label}
			className={cn("w-full overflow-visible", className)}
			style={{ height }}
		>
			{grid
				? [0.25, 0.5, 0.75, 1].map((f) => (
						<line
							key={f}
							x1={0}
							x2={width}
							y1={height * f - 0.5}
							y2={height * f - 0.5}
							className="stroke-border"
							vectorEffect="non-scaling-stroke"
						/>
					))
				: null}
			{limit !== undefined && limit > 0 ? (
				<line
					x1={0}
					x2={width}
					y1={y(limit)}
					y2={y(limit)}
					className="stroke-destructive/60"
					strokeDasharray="4 4"
					vectorEffect="non-scaling-stroke"
				/>
			) : null}
			{markers.map((f) => (
				<line
					key={f}
					x1={f * width}
					x2={f * width}
					y1={0}
					y2={height}
					className="stroke-warning"
					strokeDasharray="3 3"
					vectorEffect="non-scaling-stroke"
				/>
			))}
			{series.map((s, i) =>
				s.values.length > 1 ? (
					<path
						key={i}
						d={path(s.values)}
						fill="none"
						className={
							s.muted ? "stroke-muted-foreground/60" : "stroke-foreground"
						}
						strokeWidth={1.5}
						strokeLinejoin="round"
						vectorEffect="non-scaling-stroke"
					/>
				) : null,
			)}
		</svg>
	);
}
