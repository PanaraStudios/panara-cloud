"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { ActivityIcon } from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type {
	LogEntry,
	LogPage,
} from "@/components/dashboard/requests/show-requests";
import { useAccessLog } from "@/components/dashboard/requests/use-access-log";
import { FootNote } from "@/components/servers/server-ui";
import { Toolbar, ToolbarSearch } from "@/components/shared/list-toolbar";
import { QuietError } from "@/components/shared/quiet-error";
import { Segmented } from "@/components/shared/segmented";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	copyToClipboard,
	EmptyState,
	MoreMenu,
	ResourceTable,
	StatCell,
	StatStrip,
	Th,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { useQueryResult } from "@/lib/host-data";
import { useOrganization } from "@/lib/organization";
import { cn } from "@/lib/utils";
import { ActivityPage, FilterSelect } from "./activity-ui";
import {
	type DirectoryService,
	serviceOfTraefikName,
	useDirectory,
} from "./use-directory";

type StatusFilter = "all" | "success" | "redirect" | "client" | "server";
type Range = "1h" | "24h" | "7d";

const RANGES: Record<Range, { label: string; ms: number }> = {
	"1h": { label: "1 h", ms: 3600_000 },
	"24h": { label: "24 h", ms: 24 * 3600_000 },
	"7d": { label: "7 d", ms: 7 * 24 * 3600_000 },
};

const PAGE_SIZE = 50;
const SAMPLE_SIZE = 500;

const ms = (nanos: number | undefined) => (nanos ?? 0) / 1_000_000;

const formatMs = (nanos: number | undefined) => {
	const value = ms(nanos);
	if (value >= 10_000) return `${(value / 1000).toFixed(1)}s`;
	return `${Math.round(value)}ms`;
};

const formatBytes = (bytes: number | undefined) => {
	const value = bytes ?? 0;
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${(value / 1024 / 1024).toFixed(1)} MB`;
};

const statusClass = (status: number) =>
	status >= 500
		? "text-destructive"
		: status >= 400
			? "text-warning"
			: status >= 300
				? "text-muted-foreground"
				: undefined;

const timeOf = (entry: LogEntry) => {
	const at = new Date(entry.StartUTC);
	if (Number.isNaN(at.getTime())) return "—";
	return `${at.toLocaleTimeString([], { hour12: false })}.${String(at.getMilliseconds()).padStart(3, "0")}`;
};

const formatCount = (value: number) =>
	value >= 10_000 ? `${(value / 1000).toFixed(1)}k` : value.toLocaleString();

function percentile(values: number[], p: number) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function curlOf(entry: LogEntry) {
	const url = `${entry.RequestScheme || "https"}://${entry.RequestHost}${entry.RequestPath}`;
	const method =
		entry.RequestMethod && entry.RequestMethod !== "GET"
			? ` -X ${entry.RequestMethod}`
			: "";
	const agent = entry.request_User_Agent
		? ` -H 'User-Agent: ${entry.request_User_Agent.replace(/'/g, "'\\''")}'`
		: "";
	return `curl${method}${agent} '${url.replace(/'/g, "'\\''")}'`;
}

function Bars({ stats }: { stats: { hour: string; count: number }[] }) {
	const max = Math.max(1, ...stats.map((item) => item.count));
	return (
		<TooltipProvider delay={0}>
			<div className="flex h-7 w-full min-w-0 items-end gap-0.5">
				{stats.slice(-48).map((item) => (
					<Tooltip key={item.hour}>
						{/* The column is the hover target: an hour with no requests
						    is a sliver too thin to point at. */}
						<TooltipTrigger
							render={
								<div className="group flex h-full max-w-6 flex-1 items-end" />
							}
						>
							<div
								className="w-full rounded-[2px] bg-muted-foreground/25 transition-colors group-hover:bg-foreground/70"
								style={{
									height: `${Math.max(4, (item.count / max) * 100)}%`,
								}}
							/>
						</TooltipTrigger>
						<TooltipContent>
							<span className="font-medium">
								{item.count.toLocaleString()}{" "}
								{item.count === 1 ? "request" : "requests"}
							</span>
							<span className="opacity-70">
								{new Date(item.hour).toLocaleString([], {
									day: "numeric",
									month: "short",
									hour: "2-digit",
									minute: "2-digit",
								})}
							</span>
						</TooltipContent>
					</Tooltip>
				))}
			</div>
		</TooltipProvider>
	);
}

function RequestDetail({
	entry,
	service,
}: {
	entry: LogEntry;
	service: DirectoryService | undefined;
}) {
	const total = ms(entry.Duration);
	const origin = ms(entry.OriginDuration);
	const overhead = Math.max(0, total - origin);
	const failed = entry.DownstreamStatus >= 500;
	const upstream = entry.ServiceURL?.Host
		? `${entry.ServiceURL.Scheme || "http"}://${entry.ServiceURL.Host}`
		: entry.ServiceAddr;
	const rows: { label: string; value: React.ReactNode }[] = [
		{
			label: "Host",
			value: <span className="font-mono text-[13px]">{entry.RequestHost}</span>,
		},
		{
			label: "Routed to",
			value: (
				<>
					{service ? (
						<Link href={service.href ?? "#"} className="hover:underline">
							{service.projectName} / {service.name}
						</Link>
					) : (
						entry.ServiceName || "—"
					)}
					{entry.RouterName ? (
						<span className="text-muted-foreground">
							{" "}
							· router{" "}
							<span className="font-mono text-[12px]">{entry.RouterName}</span>
						</span>
					) : null}
				</>
			),
		},
		{
			label: "Upstream",
			value: upstream ? (
				<span className="font-mono text-[13px]">{upstream}</span>
			) : (
				"—"
			),
		},
		{
			label: "Client",
			value: (
				<>
					<span className="font-mono text-[13px]">{entry.ClientHost}</span>
					{entry.request_User_Agent ? (
						<span className="text-muted-foreground">
							{" "}
							· {entry.request_User_Agent}
						</span>
					) : null}
				</>
			),
		},
		{
			label: "Protocol",
			value: `${entry.RequestProtocol ?? "—"} · ${entry.entryPointName ?? "—"}`,
		},
		{
			label: "Size",
			value: `${formatBytes(entry.RequestContentSize)} in · ${formatBytes(entry.DownstreamContentSize)} out`,
		},
	];
	return (
		<div className="flex flex-col gap-5 py-2 lg:flex-row lg:gap-10">
			<div className="flex min-w-0 flex-1 flex-col gap-4">
				<dl className="flex flex-col border-border border-t">
					{rows.map((row) => (
						<div
							key={row.label}
							className="flex items-start gap-4 border-border border-b py-2 text-sm"
						>
							<dt className="w-28 shrink-0 text-muted-foreground">
								{row.label}
							</dt>
							<dd className="min-w-0 flex-1 break-words">{row.value}</dd>
						</div>
					))}
				</dl>
				<div className="flex flex-col gap-2">
					<span className="font-medium text-sm">
						Timing{" "}
						<span className="font-normal text-muted-foreground">
							{formatMs(entry.Duration)}
						</span>
					</span>
					<div className="flex h-2 overflow-hidden rounded-full bg-muted">
						<div
							className="bg-muted-foreground/60"
							style={{ width: `${total ? (overhead / total) * 100 : 0}%` }}
						/>
						<div
							className={failed ? "bg-destructive" : "bg-foreground/70"}
							style={{ width: `${total ? (origin / total) * 100 : 0}%` }}
						/>
					</div>
					<div className="flex justify-between gap-4 text-sm">
						<span className="text-muted-foreground">
							Traefik {Math.round(overhead)} ms
						</span>
						<span
							className={failed ? "text-destructive" : "text-muted-foreground"}
						>
							Upstream {Math.round(origin).toLocaleString()} ms
							{entry.OriginStatus === 0 && failed ? " · no response" : ""}
						</span>
					</div>
				</div>
			</div>
			<div className="flex w-full shrink-0 flex-col items-start gap-2 lg:w-60">
				<Button
					variant="outline"
					size="sm"
					onClick={() => copyToClipboard(curlOf(entry), "curl command")}
				>
					Copy as curl
				</Button>
				<Button
					variant="outline"
					size="sm"
					onClick={() =>
						copyToClipboard(JSON.stringify(entry, null, 2), "Request")
					}
				>
					Copy JSON
				</Button>
				{service?.href ? (
					<Button
						variant="outline"
						size="sm"
						nativeButton={false}
						render={<Link href={`${service.href}/logs`} />}
					>
						Open {service.name} logs
					</Button>
				) : null}
			</div>
		</div>
	);
}

function LogCleanup({ initial }: { initial: string | undefined }) {
	const { active } = useOrganization();
	const update = useMutation(api.live.accessLog.setCleanupSchedule);
	const [cron, setCron] = useState(initial || "0 0 * * *");
	useEffect(() => {
		if (initial) setCron(initial);
	}, [initial]);
	return (
		<section className="mt-2 flex flex-col gap-4 border-border border-t pt-8">
			<div className="space-y-1">
				<h2 className="font-semibold text-[15px]">Log cleanup</h2>
				<p className="text-muted-foreground text-sm">
					At this time the access log is cut to its last 1,000 entries and
					Traefik reopens its log file.
				</p>
			</div>
			<div className="flex items-center gap-2">
				<Input
					aria-label="Cleanup schedule"
					placeholder="0 0 * * *"
					value={cron}
					onChange={(event) => setCron(event.target.value)}
					className="max-w-60 font-mono text-[13px]"
				/>
				<Button
					variant="outline"
					size="lg"
					disabled={!!initial && cron.trim() === initial}
					onClick={() => {
						if (!cron.trim()) return toast.error("Enter a cron expression");
						update({ organizationId: active.id, cronExpression: cron })
							.then(() => toast.success("Log cleanup schedule saved"))
							.catch((error) => toast.error(errorMessage(error)));
					}}
				>
					Save
				</Button>
			</div>
		</section>
	);
}

function RequestsData() {
	const directory = useDirectory();
	const [path, setPath] = useState("");
	const [host, setHost] = useState("all");
	const [status, setStatus] = useState<StatusFilter>("all");
	const [range, setRange] = useState<Range>("24h");
	const [pageIndex, setPageIndex] = useState(0);
	const [open, setOpen] = useState<LogEntry | null>(null);
	const [knownHosts, setKnownHosts] = useState<string[]>([]);
	// Rounded to the minute so the payload (and the poll behind it) only
	// changes once a minute.
	const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
	useEffect(() => {
		const timer = setInterval(
			() => setMinute(Math.floor(Date.now() / 60_000)),
			15_000,
		);
		return () => clearInterval(timer);
	}, []);
	useEffect(() => {
		setPageIndex(0);
	}, [path, host, status, range]);

	const dateRange = {
		start: new Date(minute * 60_000 - RANGES[range].ms).toISOString(),
	};
	const scope = {
		host: host === "all" ? undefined : host,
		path: path.trim() || undefined,
		dateRange,
	};

	const sample = useAccessLog<LogPage>(
		"query",
		{ ...scope, page: { pageIndex: 0, pageSize: SAMPLE_SIZE } },
		{ refetchInterval: 10_000 },
	);
	const errors = useAccessLog<LogPage>(
		"query",
		{ ...scope, status: ["server"], page: { pageIndex: 0, pageSize: 1 } },
		{ refetchInterval: 10_000 },
	);
	const stats = useAccessLog<{ hour: string; count: number }[]>(
		"stats",
		{ dateRange },
		{ refetchInterval: 30_000 },
	);
	const page = useAccessLog<LogPage>(
		"query",
		{
			...scope,
			status: status === "all" ? undefined : [status],
			page: { pageIndex, pageSize: PAGE_SIZE },
		},
		{ refetchInterval: 3000 },
	);

	useEffect(() => {
		const hosts = sample.data?.data.map((entry) => entry.RequestHost) ?? [];
		if (hosts.length === 0) return;
		setKnownHosts((previous) => {
			const next = new Set([...previous, ...hosts.filter(Boolean)]);
			return next.size === previous.length ? previous : [...next].sort();
		});
	}, [sample.data]);

	const total = sample.data?.totalCount;
	const errorRate =
		total && errors.data ? (errors.data.totalCount / total) * 100 : null;
	const p95 = useMemo(
		() =>
			percentile(
				(sample.data?.data ?? []).map((entry) => ms(entry.Duration)),
				0.95,
			),
		[sample.data],
	);
	const totalPages = page.data
		? Math.max(1, Math.ceil(page.data.totalCount / PAGE_SIZE))
		: 1;

	return (
		<>
			<Toolbar>
				<ToolbarSearch
					value={path}
					onChange={setPath}
					placeholder="Filter by path…"
					className="sm:w-64"
				/>
				<FilterSelect
					label="Host"
					value={host}
					onValueChange={setHost}
					options={knownHosts.map((item) => ({ value: item, label: item }))}
				/>
				<Segmented
					aria-label="Status class"
					value={status}
					onValueChange={setStatus}
					items={[
						{ value: "all", label: "All" },
						{ value: "success", label: "2xx" },
						{ value: "redirect", label: "3xx" },
						{ value: "client", label: "4xx" },
						{ value: "server", label: "5xx" },
					]}
				/>
				<div className="ml-auto">
					<FilterSelect
						label="Last"
						value={range === "24h" ? "all" : range}
						onValueChange={(value) =>
							setRange(value === "1h" || value === "7d" ? value : "24h")
						}
						allLabel="24 h"
						options={(["1h", "7d"] as const).map((value) => ({
							value,
							label: RANGES[value].label,
						}))}
					/>
				</div>
			</Toolbar>

			<StatStrip className="lg:grid-flow-row lg:grid-cols-[repeat(3,minmax(0,11rem))_minmax(0,1fr)]">
				<StatCell label="Requests" big>
					{total === undefined ? "—" : formatCount(total)}
				</StatCell>
				<StatCell label="Errors (5xx)" big>
					<span className={errorRate ? "text-destructive" : undefined}>
						{errorRate === null ? "—" : `${errorRate.toFixed(1)}%`}
					</span>
				</StatCell>
				<StatCell label="p95" big>
					{p95 === null ? "—" : Math.round(p95).toLocaleString()}
					{p95 === null ? null : (
						<span className="font-normal text-muted-foreground text-sm">
							ms
						</span>
					)}
				</StatCell>
				<div className="flex min-w-0 flex-col gap-1 px-4 py-3">
					<span className="truncate text-caption text-muted-foreground">
						Requests per hour
					</span>
					<Bars stats={stats.data ?? []} />
				</div>
			</StatStrip>

			{page.isError ? (
				<QuietError
					message="Couldn't read the access log on the panel host."
					detail={page.error?.message}
				/>
			) : page.data === undefined ? (
				<Skeleton className="h-80 w-full rounded-xl" />
			) : (
				<ResourceTable
					headers={
						<>
							<Th className="w-36">Time</Th>
							<Th className="w-20">Method</Th>
							<Th className="w-20">Status</Th>
							<Th>Path</Th>
							<Th className="w-48">Service</Th>
							<Th className="w-24 text-right">Duration</Th>
							<Th className="w-36">Client IP</Th>
						</>
					}
				>
					{page.data.data.map((entry, index) => {
						const service = serviceOfTraefikName(
							entry.ServiceName,
							directory.byAppName,
						);
						const isOpen = open === entry;
						const failed = entry.DownstreamStatus >= 500;
						return (
							<Fragment
								// Access-log lines carry no id of their own.
								key={`${entry.StartUTC}-${entry.ClientAddr}-${index}`}
							>
								<TableRow
									className="cursor-pointer font-mono text-[13px]"
									aria-expanded={isOpen}
									onClick={() => setOpen(isOpen ? null : entry)}
								>
									<TableCell className="text-muted-foreground">
										{timeOf(entry)}
									</TableCell>
									<TableCell>{entry.RequestMethod}</TableCell>
									<TableCell className={statusClass(entry.DownstreamStatus)}>
										{entry.DownstreamStatus || "—"}
									</TableCell>
									<TableCell className="max-w-0 truncate">
										{entry.RequestPath}
									</TableCell>
									<TableCell className="max-w-0 truncate font-sans text-sm">
										{service
											? `${service.projectName} / ${service.name}`
											: entry.RequestHost}
									</TableCell>
									<TableCell
										className={cn("text-right", failed && "text-destructive")}
									>
										{formatMs(entry.Duration)}
									</TableCell>
									<TableCell className="text-muted-foreground">
										{entry.ClientHost}
									</TableCell>
								</TableRow>
								{isOpen ? (
									<TableRow className="hover:bg-transparent">
										<TableCell colSpan={7} className="whitespace-normal px-4">
											<RequestDetail entry={entry} service={service} />
										</TableCell>
									</TableRow>
								) : null}
							</Fragment>
						);
					})}
					{page.data.data.length === 0 ? (
						<TableRow>
							<TableCell
								colSpan={7}
								className="h-24 text-center text-muted-foreground"
							>
								No requests match these filters.
							</TableCell>
						</TableRow>
					) : null}
				</ResourceTable>
			)}
			<div className="flex flex-wrap items-center justify-between gap-3">
				<FootNote>
					Click a row for the full request. The newest 20,000 log lines are
					searched; per-service traffic is under each service's Logs.
				</FootNote>
				{totalPages > 1 ? (
					<div className="flex items-center gap-2">
						<span className="text-muted-foreground text-sm">
							{pageIndex + 1} of {totalPages}
						</span>
						<Button
							variant="outline"
							size="sm"
							disabled={pageIndex === 0}
							onClick={() => setPageIndex((index) => index - 1)}
						>
							Previous
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={pageIndex + 1 >= totalPages}
							onClick={() => setPageIndex((index) => index + 1)}
						>
							Next
						</Button>
					</div>
				) : null}
			</div>
			{sample.data &&
			sample.data.totalCount === 0 &&
			host === "all" &&
			!path ? (
				<p className="text-muted-foreground text-sm">
					No requests logged yet. If you just turned logging on, reload Traefik
					from the panel host's Traefik page.
				</p>
			) : null}
		</>
	);
}

export function RequestsView() {
	const { active } = useOrganization();
	const status = useQueryResult(api.live.accessLog.status, {
		organizationId: active.id,
	});
	const toggle = useMutation(api.live.accessLog.toggle);
	const statusError = status instanceof Error ? status.message : null;
	const enabled = status instanceof Error ? undefined : status?.enabled;
	const cleanup =
		status instanceof Error ? undefined : status?.cronExpression || undefined;

	const setLogging = (enable: boolean) =>
		toggle({ organizationId: active.id, enable })
			.then(() =>
				toast.success(
					enable
						? "Request logging on. Reload Traefik to apply it."
						: "Request logging off. Reload Traefik to apply it.",
				),
			)
			.catch((error) => toast.error(errorMessage(error)));

	return (
		<ActivityPage
			actions={
				enabled ? (
					<MoreMenu>
						<DropdownMenuItem onClick={() => setLogging(false)}>
							Turn off request logging
						</DropdownMenuItem>
					</MoreMenu>
				) : null
			}
		>
			{statusError ? (
				<QuietError
					message="Couldn't check request logging on the panel host."
					detail={statusError}
				/>
			) : null}
			{status === undefined ? (
				<Skeleton className="h-80 w-full rounded-xl" />
			) : enabled ? (
				<RequestsData />
			) : enabled === false ? (
				<EmptyState
					icon={ActivityIcon}
					title="Request logging is off"
					description="Turn it on to see traffic and every request Traefik routes. Reload Traefik afterwards for it to take effect."
				>
					<Button onClick={() => setLogging(true)}>Turn on</Button>
				</EmptyState>
			) : null}
			{enabled !== undefined ? <LogCleanup initial={cleanup} /> : null}
		</ActivityPage>
	);
}
