"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { ActivityIcon, PowerIcon, PowerOffIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useAccessLog } from "@/components/dashboard/requests/use-access-log";
import { FootNote } from "@/components/servers/server-ui";
import { QuietError } from "@/components/shared/quiet-error";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	AccessDeniedState,
	EmptyState,
	MoreMenu,
	StatCell,
	StatStrip,
} from "@/components/ui-kit/primitives";
import { deniedResource } from "@/lib/access-denied";
import { errorMessage } from "@/lib/auth/errors";
import { useQueryResult } from "@/lib/host-data";
import { canReadRequests } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { type AccessPage, nanosToMs, percentile } from "@/lib/requests";
import { ActivityPage } from "./activity-ui";
import { type RequestFilters, RequestsLog } from "./requests-log";

const SAMPLE_SIZE = 500;

const formatCount = (value: number) =>
	value >= 10_000 ? `${(value / 1000).toFixed(1)}k` : value.toLocaleString();

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

function Figures({ filters }: { filters: RequestFilters }) {
	const { dateRange, ...scope } = filters;
	const sample = useAccessLog<AccessPage>(
		"query",
		{ ...scope, dateRange, page: { pageIndex: 0, pageSize: SAMPLE_SIZE } },
		{ refetchInterval: 10_000 },
	);
	const errors = useAccessLog<AccessPage>(
		"query",
		{
			...scope,
			dateRange,
			status: ["server"],
			page: { pageIndex: 0, pageSize: 1 },
		},
		{ refetchInterval: 10_000 },
	);
	const stats = useAccessLog<{ hour: string; count: number }[]>(
		"stats",
		{ dateRange },
		{ refetchInterval: 30_000 },
	);
	const total = sample.data?.totalCount;
	const p95 = useMemo(
		() =>
			percentile(
				(sample.data?.data ?? []).map((entry) => nanosToMs(entry.Duration)),
				0.95,
			),
		[sample.data],
	);
	return (
		<RequestFigures
			total={total}
			errorRate={
				total && errors.data ? (errors.data.totalCount / total) * 100 : null
			}
			p95={p95 ?? null}
			stats={stats.data ?? []}
		/>
	);
}

/** The figures over the request list: how many, how many failed, how slow,
    and when. */
export function RequestFigures({
	total,
	errorRate,
	p95,
	stats,
}: {
	total: number | undefined;
	errorRate: number | null;
	p95: number | null;
	stats: { hour: string; count: number }[];
}) {
	return (
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
					<span className="font-normal text-muted-foreground text-sm">ms</span>
				)}
			</StatCell>
			<div className="flex min-w-0 flex-col gap-1 px-4 py-3">
				<span className="truncate text-caption text-muted-foreground">
					Requests per hour
				</span>
				<Bars stats={stats} />
			</div>
		</StatStrip>
	);
}

const figures = (filters: RequestFilters) => <Figures filters={filters} />;

function RequestsData() {
	return (
		<>
			<RequestsLog
				banner={figures}
				className="h-[calc(100svh-25rem)] min-h-96 max-sm:-mx-6 max-sm:rounded-none max-sm:border-x-0"
			/>
			<FootNote>
				The newest request is at the top; click one for the whole request. The
				newest 20,000 log lines are searched; per-service traffic is under each
				service's Logs.
			</FootNote>
		</>
	);
}

export function RequestsView() {
	const { active } = useOrganization();
	// Admins only, on the backend too: nobody else is asked for.
	const canRead = canReadRequests(usePermissions());
	const status = useQueryResult(
		api.live.accessLog.status,
		canRead ? { organizationId: active.id } : "skip",
	);
	const toggle = useMutation(api.live.accessLog.toggle);
	const denied =
		!canRead || (status instanceof Error && deniedResource(status) !== null);
	const statusError = status instanceof Error ? errorMessage(status) : null;
	const state = status instanceof Error ? undefined : status;
	const enabled = state?.enabled;
	const changing = state?.changing ?? false;
	const cleanup = state?.cronExpression || undefined;
	// The switch is a job on the host (it rewrites Traefik's config and
	// restarts it): what is said about it waits for how that job ended.
	const asked = useRef<{ jobId: string; enable: boolean } | null>(null);
	const [sending, setSending] = useState(false);

	const setLogging = async (enable: boolean) => {
		setSending(true);
		try {
			const jobId = await toggle({ organizationId: active.id, enable });
			asked.current = { jobId, enable };
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setSending(false);
		}
	};

	const settledJob = state && !state.changing ? state.lastJobId : null;
	const failure = state?.failure ?? null;
	useEffect(() => {
		const mine = asked.current;
		if (!mine || mine.jobId !== settledJob) return;
		asked.current = null;
		if (failure) {
			toast.error(
				mine.enable
					? "Couldn't turn request logging on"
					: "Couldn't turn request logging off",
				{ description: failure },
			);
		} else {
			toast.success(
				mine.enable ? "Request logging is on" : "Request logging is off",
			);
		}
	}, [settledJob, failure]);

	const busy = sending || changing;
	const waiting = busy ? "Waiting for the host…" : null;

	// The tab isn't offered to this member; its address says so calmly.
	if (denied) {
		return (
			<ActivityPage>
				<AccessDeniedState what="the request log" />
			</ActivityPage>
		);
	}

	return (
		<ActivityPage
			actions={
				enabled ? (
					<MoreMenu>
						<DropdownMenuItem
							disabled={busy}
							onClick={() => void setLogging(false)}
						>
							<PowerOffIcon className="text-muted-foreground" />
							{busy
								? "Turning off request logging…"
								: "Turn off request logging"}
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
			{failure && !busy ? (
				<QuietError
					message={
						enabled
							? "Request logging is still on: turning it off failed on the panel host."
							: "Request logging is still off: turning it on failed on the panel host."
					}
					detail={failure}
				/>
			) : null}
			{state === undefined && !statusError ? (
				<Skeleton className="h-80 w-full rounded-xl" />
			) : enabled ? (
				<RequestsData />
			) : enabled === false ? (
				<EmptyState
					icon={ActivityIcon}
					title="Request logging is off"
					description="Turn it on to see traffic and every request Traefik routes. Traefik restarts once to start writing its access log."
				>
					<Button
						isLoading={busy}
						disabledReason={waiting}
						onClick={() => void setLogging(true)}
					>
						<PowerIcon />
						{busy ? "Turning on…" : "Turn on"}
					</Button>
				</EmptyState>
			) : null}
			{enabled !== undefined ? <LogCleanup initial={cleanup} /> : null}
		</ActivityPage>
	);
}
