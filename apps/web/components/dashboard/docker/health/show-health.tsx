"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import { Download, RefreshCw, StethoscopeIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	FailureNote,
	Meter,
	SectionNote,
	StatusText,
} from "@/components/servers/server-ui";
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Section } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { useOpResult, useQueryResult } from "@/lib/host-data";
import { cn } from "@/lib/utils";

interface Props {
	serverId?: string;
}

const bytesToGb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
const nanoCpusToCores = (nanoCpus: number) => (nanoCpus / 1e9).toFixed(2);
const pct = (used: number, total: number) =>
	Math.min(100, Math.round((used / (total || 1)) * 100));

type HealthData = {
	checkedAt: string;
	error?: string;
	containers: { containerCount: number; serviceCount: number };
	resources: { memTotalBytes: number; memUsedBytes: number; cpuCount: number };
	inotify: {
		maxWatches: number;
		maxInstances: number;
		maxQueuedEvents: number;
		currentInstances: number;
		persisted: boolean;
	};
	disk: { totalBytes: number; usedBytes: number };
	dockerNetworks: {
		count: number;
		addressPools: unknown;
		usage: {
			name: string;
			driver: string;
			subnet: string | null;
			containersInUse: number;
			capacity: number | null;
			percentUsed: number | null;
		}[];
		usageError?: string;
	};
	daemonErrors: string[];
	daemonLogsWindow: { fromEpoch: number; toEpoch: number } | null;
	reservation: {
		memoryReservedBytes: number;
		cpuReservedNanoCpus: number;
		appCount: number;
		unsupportedComposeCount: number;
	} | null;
};

const EMPTY_HEALTH: HealthData = {
	checkedAt: new Date(0).toISOString(),
	containers: { containerCount: 0, serviceCount: 0 },
	resources: { memTotalBytes: 0, memUsedBytes: 0, cpuCount: 0 },
	inotify: {
		maxWatches: 0,
		maxInstances: 0,
		maxQueuedEvents: 0,
		currentInstances: 0,
		persisted: false,
	},
	disk: { totalBytes: 0, usedBytes: 0 },
	dockerNetworks: { count: 0, addressPools: null, usage: [] },
	daemonErrors: [],
	daemonLogsWindow: null,
	reservation: null,
};

const SINCE_HOURS_OPTIONS = [
	{ label: "Last hour", value: 1 },
	{ label: "Last 6 hours", value: 6 },
	{ label: "Last 24 hours", value: 24 },
	{ label: "Last 7 days", value: 168 },
];

// Server health for the last `sinceHours`: the agent runs the check
// as a one-off job; the reservation summary comes from Convex data.
function useServerHealth(serverId: string | undefined, sinceHours: number) {
	const start = useMutation(api.infra.docker.health);
	const [jobId, setJobId] = useState<Id<"jobs"> | null>(null);
	const [starting, setStarting] = useState(false);
	const [requestError, setRequestError] = useState<string | null>(null);
	const [last, setLast] = useState<HealthData | undefined>();
	const server = serverId ? (serverId as Id<"servers">) : undefined;
	const refetch = useCallback(async () => {
		setStarting(true);
		setRequestError(null);
		try {
			setJobId(await start({ serverId: server, sinceHours }));
		} catch (error) {
			setRequestError(errorMessage(error));
		} finally {
			setStarting(false);
		}
	}, [start, server, sinceHours]);
	useEffect(() => {
		void refetch();
	}, [refetch]);
	const op = useOpResult<Omit<HealthData, "reservation">>(jobId);
	useEffect(() => {
		if (op.data) setLast({ ...op.data, reservation: null });
	}, [op.data]);
	const reservation = useQueryResult(
		api.infra.docker.reservation,
		server ? { serverId: server } : {},
	);
	const error = requestError ?? op.error;
	const data = useMemo<HealthData | undefined>(
		() => (op.data ? { ...op.data, reservation: null } : last),
		[op.data, last],
	);
	const health = useMemo<HealthData | undefined>(() => {
		const withReservation = data && {
			...data,
			reservation:
				reservation && !(reservation instanceof Error) ? reservation : null,
		};
		if (error) return { ...(withReservation ?? EMPTY_HEALTH), error };
		return withReservation;
	}, [data, reservation, error]);
	return {
		health,
		isFetching: starting || op.isLoading,
		isFetched: data !== undefined || !!error,
		refetch,
	};
}

/** One diagnostic: what was checked, the reading, and a note or bar. */
function CheckLine({
	label,
	value,
	note,
	percent,
}: {
	label: string;
	value: React.ReactNode;
	note?: React.ReactNode;
	percent?: number;
}) {
	return (
		<div className="grid grid-cols-[10rem_minmax(0,1fr)] items-center gap-x-4 gap-y-1 border-border border-b py-2.5 text-sm sm:grid-cols-[12rem_minmax(0,14rem)_minmax(0,1fr)]">
			<span className="text-muted-foreground">{label}</span>
			<span className="flex min-w-0 items-center gap-3">
				<span className="shrink-0 tabular-nums">{value}</span>
				{percent !== undefined ? (
					<Meter
						percent={percent}
						tone={percent >= 90 ? "warning" : undefined}
						className="max-w-24"
					/>
				) : null}
			</span>
			{note ? (
				<span className="col-span-2 min-w-0 text-muted-foreground sm:col-span-1">
					{note}
				</span>
			) : null}
		</div>
	);
}

export const ShowHealth = ({ serverId }: Props) => {
	const [sinceHours, setSinceHours] = useState(24);
	const { health, isFetching, isFetched, refetch } = useServerHealth(
		serverId,
		sinceHours,
	);

	const memUsedPct = health
		? pct(health.resources.memUsedBytes, health.resources.memTotalBytes)
		: 0;
	const diskUsedPct = health
		? pct(health.disk.usedBytes, health.disk.totalBytes)
		: 0;
	const inotifyUsedPct = health
		? pct(health.inotify.currentInstances, health.inotify.maxInstances)
		: 0;

	const daemonLogsWindowText = health?.daemonLogsWindow
		? `Logs from ${new Date(health.daemonLogsWindow.fromEpoch * 1000).toLocaleString()} to ${new Date(health.daemonLogsWindow.toEpoch * 1000).toLocaleString()}`
		: null;
	const daemonErrorsText = [
		daemonLogsWindowText,
		health && health.daemonErrors.length > 0
			? health.daemonErrors.join("\n")
			: "(no daemon errors matched in this window)",
	]
		.filter(Boolean)
		.join("\n\n");

	const buildHealthReport = () => {
		if (!health) return "";
		const lines: string[] = [];
		lines.push("# Panara Cloud server health report");
		lines.push(`Generated: ${new Date(health.checkedAt).toLocaleString()}`);
		lines.push(
			`Window: ${SINCE_HOURS_OPTIONS.find((o) => o.value === sinceHours)?.label ?? `${sinceHours}h`}`,
		);
		lines.push("");

		lines.push("## Containers & services");
		lines.push(`Containers: ${health.containers.containerCount}`);
		lines.push(`Swarm services: ${health.containers.serviceCount}`);
		lines.push("");

		lines.push("## Host resources");
		lines.push(
			`Memory: ${bytesToGb(health.resources.memUsedBytes)} / ${bytesToGb(health.resources.memTotalBytes)} GB`,
		);
		lines.push(`CPU cores: ${health.resources.cpuCount}`);
		lines.push("");

		lines.push("## Disk (/)");
		lines.push(
			`${bytesToGb(health.disk.usedBytes)} / ${bytesToGb(health.disk.totalBytes)} GB`,
		);
		lines.push("");

		lines.push("## Inotify");
		lines.push(
			`max_user_instances: ${health.inotify.currentInstances} / ${health.inotify.maxInstances}`,
		);
		lines.push(`max_user_watches: ${health.inotify.maxWatches}`);
		lines.push(`max_queued_events: ${health.inotify.maxQueuedEvents}`);
		lines.push(
			`Persisted in sysctl: ${health.inotify.persisted ? "yes" : "no"}`,
		);
		lines.push("");

		lines.push("## Docker networks");
		lines.push(`Total networks: ${health.dockerNetworks.count}`);
		if (health.dockerNetworks.addressPools) {
			lines.push(
				`default-address-pools: ${JSON.stringify(health.dockerNetworks.addressPools)}`,
			);
		}
		if (health.dockerNetworks.usageError) {
			lines.push(
				`Could not read network IP usage: ${health.dockerNetworks.usageError}`,
			);
		} else if (health.dockerNetworks.usage.length > 0) {
			lines.push("");
			lines.push(
				"| Network | Driver | Subnet | IPs in use | Capacity | Usage |",
			);
			lines.push("|---|---|---|---|---|---|");
			for (const n of health.dockerNetworks.usage) {
				lines.push(
					`| ${n.name} | ${n.driver} | ${n.subnet ?? "auto"} | ${n.containersInUse} | ${n.capacity ?? "—"} | ${n.percentUsed ?? "—"}% |`,
				);
			}
		}
		lines.push("");

		if (health.reservation) {
			lines.push("## Memory/CPU reservation");
			lines.push(
				`Reserved memory: ${bytesToGb(health.reservation.memoryReservedBytes)} GB`,
			);
			lines.push(
				`Reserved CPU: ${nanoCpusToCores(health.reservation.cpuReservedNanoCpus)} cores`,
			);
			lines.push(`Across ${health.reservation.appCount} Application services`);
			if (health.reservation.unsupportedComposeCount > 0) {
				lines.push(
					`${health.reservation.unsupportedComposeCount} Compose service(s) not included (not tracked per-service)`,
				);
			}
			lines.push("");
		}

		lines.push("## Docker daemon errors (raw)");
		lines.push("```");
		lines.push(daemonErrorsText);
		lines.push("```");

		return lines.join("\n");
	};

	const handleDownload = () => {
		const report = buildHealthReport();
		if (!report) return;
		const blob = new Blob([report], { type: "text/markdown" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `panara-cloud-health-report-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
		a.click();
		URL.revokeObjectURL(url);
	};

	const windowLabel =
		SINCE_HOURS_OPTIONS.find(
			(option) => option.value === sinceHours,
		)?.label.toLowerCase() ?? "";
	const result = health && !health.error ? health : null;

	return (
		<Section
			title="Server diagnostics"
			icon={StethoscopeIcon}
			hint="inotify limits, disk, the Docker network pool and daemon errors"
			actions={
				<>
					<Select
						value={String(sinceHours)}
						onValueChange={(v) => setSinceHours(Number(v))}
					>
						<SelectTrigger size="sm" className="w-36" aria-label="Time range">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{SINCE_HOURS_OPTIONS.map((opt) => (
								<SelectItem key={opt.value} value={String(opt.value)}>
									{opt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button
						variant="outline"
						size="sm"
						onClick={() => refetch()}
						disabled={isFetching}
					>
						<RefreshCw
							data-icon="inline-start"
							className={isFetching ? "animate-spin" : undefined}
						/>
						{isFetched ? "Check again" : "Check"}
					</Button>
					{result ? (
						<Button variant="outline" size="sm" onClick={handleDownload}>
							<Download data-icon="inline-start" />
							Download report
						</Button>
					) : null}
				</>
			}
		>
			{health?.error ? (
				<FailureNote error={health.error} what="server health" />
			) : !result ? (
				<SectionNote>
					{isFetching ? "Checking this server…" : "Not checked yet."}
				</SectionNote>
			) : (
				<div
					className={cn(
						"flex flex-col transition-opacity",
						isFetching && "opacity-50",
					)}
				>
					<CheckLine
						label="Containers"
						value={result.containers.containerCount}
						note={`${result.containers.serviceCount} swarm services`}
					/>
					<CheckLine
						label="Memory"
						value={
							result.resources.memTotalBytes > 0
								? `${bytesToGb(result.resources.memUsedBytes)} / ${bytesToGb(result.resources.memTotalBytes)} GB`
								: "Not reported"
						}
						percent={
							result.resources.memTotalBytes > 0 ? memUsedPct : undefined
						}
						note={`${result.resources.cpuCount} CPU cores`}
					/>
					<CheckLine
						label="Disk (/)"
						value={`${bytesToGb(result.disk.usedBytes)} / ${bytesToGb(result.disk.totalBytes)} GB`}
						percent={diskUsedPct}
					/>
					<CheckLine
						label="Inotify instances"
						value={`${result.inotify.currentInstances} / ${result.inotify.maxInstances.toLocaleString()}`}
						percent={inotifyUsedPct}
						note={
							<>
								{result.inotify.maxWatches.toLocaleString()} watches ·{" "}
								{result.inotify.maxQueuedEvents.toLocaleString()} queued events
								·{" "}
								<span
									className={
										result.inotify.persisted ? undefined : "text-warning"
									}
								>
									{result.inotify.persisted ? "persisted" : "runtime only"}
								</span>
							</>
						}
					/>
					<CheckLine
						label="Docker networks"
						value={result.dockerNetworks.count}
						note={
							result.dockerNetworks.addressPools
								? "Custom address pool on this server."
								: "The default address pool runs out around 30 networks unless default-address-pools is set in /etc/docker/daemon.json."
						}
					/>
					{result.reservation ? (
						<CheckLine
							label="Reserved"
							value={`${bytesToGb(result.reservation.memoryReservedBytes)} GB · ${nanoCpusToCores(result.reservation.cpuReservedNanoCpus)} CPUs`}
							note={`Across ${result.reservation.appCount} application services.${
								result.reservation.unsupportedComposeCount > 0
									? ` ${result.reservation.unsupportedComposeCount} compose service(s) aren't counted.`
									: ""
							}`}
						/>
					) : null}

					{result.dockerNetworks.usage.length > 0 ||
					result.dockerNetworks.usageError ? (
						<div className="flex flex-col gap-2 pt-6">
							<h3 className="font-medium text-sm">Network IP usage</h3>
							<p className="max-w-3xl text-muted-foreground text-sm">
								IPs assigned to containers against each subnet's capacity. A
								network near 100% blocks new containers from starting.
							</p>
							{result.dockerNetworks.usageError ? (
								<FailureNote
									error={result.dockerNetworks.usageError}
									what="network IP usage"
								/>
							) : (
								<div className="overflow-hidden rounded-xl border border-border">
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead>Network</TableHead>
												<TableHead>Driver</TableHead>
												<TableHead>Subnet</TableHead>
												<TableHead>IPs in use</TableHead>
												<TableHead>Usage</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{result.dockerNetworks.usage.map((n) => (
												<TableRow key={n.name}>
													<TableCell className="font-mono text-[13px]">
														{n.name}
													</TableCell>
													<TableCell className="text-muted-foreground">
														{n.driver}
													</TableCell>
													<TableCell className="font-mono text-[13px] text-muted-foreground">
														{n.subnet ?? "Auto"}
													</TableCell>
													<TableCell className="text-muted-foreground tabular-nums">
														{n.capacity !== null
															? `${n.containersInUse} / ${n.capacity}`
															: n.containersInUse}
													</TableCell>
													<TableCell>
														{n.percentUsed !== null ? (
															<StatusText
																tone={
																	n.percentUsed >= 90
																		? "destructive"
																		: n.percentUsed >= 70
																			? "warning"
																			: "success"
																}
																label={`${n.percentUsed}%`}
															/>
														) : (
															<span className="text-muted-foreground">—</span>
														)}
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								</div>
							)}
						</div>
					) : null}

					<div className="flex flex-col gap-2 pt-6">
						<h3 className="font-medium text-sm">
							Docker daemon errors{" "}
							<span className="font-normal text-muted-foreground">
								{windowLabel}
							</span>
						</h3>
						{result.daemonErrors.length === 0 ? (
							<SectionNote className="py-0">
								No daemon errors in the {windowLabel}.
							</SectionNote>
						) : (
							<CodeEditor
								value={daemonErrorsText}
								language="shell"
								disabled
								lineWrapping
								wrapperClassName="h-64 overflow-hidden rounded-xl border border-border"
							/>
						)}
					</div>
				</div>
			)}
		</Section>
	);
};
