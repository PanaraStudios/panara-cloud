"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { format } from "date-fns";
import { ActivityIcon, Calendar as CalendarIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	EmptyState,
	PageHeader,
	SectionHeader,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { useQueryResult } from "@/lib/host-data";
import { useOrganization } from "@/lib/organization";
import { RequestDistributionChart } from "./request-distribution-chart";
import { RequestsTable } from "./requests-table";
import { useAccessLog } from "./use-access-log";

// One Traefik access log line (Traefik's JSON access log fields).
export interface LogEntry {
	ClientAddr: string;
	ClientHost: string;
	ClientPort: string;
	ClientUsername: string;
	DownstreamContentSize: number;
	DownstreamStatus: number;
	Duration: number;
	OriginContentSize: number;
	OriginDuration: number;
	OriginStatus: number;
	Overhead: number;
	RequestAddr: string;
	RequestContentSize: number;
	RequestCount: number;
	RequestHost: string;
	RequestMethod: string;
	RequestPath: string;
	RequestPort: string;
	RequestProtocol: string;
	RequestScheme: string;
	RetryAttempts: number;
	RouterName: string;
	ServiceAddr: string;
	ServiceName: string;
	ServiceURL: {
		Scheme: string;
		Opaque: string;
		User: null;
		Host: string;
		Path: string;
		RawPath: string;
		ForceQuery: boolean;
		RawQuery: string;
		Fragment: string;
		RawFragment: string;
	};
	StartLocal: string;
	StartUTC: string;
	downstream_Content_Type: string;
	entryPointName: string;
	level: string;
	msg: string;
	origin_Content_Type: string;
	request_Content_Type: string;
	request_User_Agent: string;
	time: string;
}

export type LogPage = { data: LogEntry[]; totalCount: number };

export const ShowRequests = () => {
	const { active } = useOrganization();
	const status = useQueryResult(api.live.accessLog.status, {
		organizationId: active.id,
	});
	const statusError = status instanceof Error ? status.message : null;
	const isActive = status instanceof Error ? undefined : status?.enabled;
	const toggleRequests = useMutation(api.live.accessLog.toggle);

	const logCleanupStatus = status instanceof Error ? undefined : status;
	const updateLogCleanup = useMutation(api.live.accessLog.setCleanupSchedule);
	const [cronExpression, setCronExpression] = useState<string | null>(null);

	// Set default date range to last 3 days
	const getDefaultDateRange = () => {
		const to = new Date();
		const from = new Date();
		from.setDate(from.getDate() - 3);
		return { from, to };
	};

	const [dateRange, setDateRange] = useState<{
		from: Date | undefined;
		to: Date | undefined;
	}>(() => getDefaultDateRange());

	// Check if logs exist to determine if traefik has been reloaded
	// Only fetch when active to minimize network calls
	const { data: statsLogsCheck } = useAccessLog<LogPage>(
		"query",
		{
			page: {
				pageIndex: 0,
				pageSize: 1,
			},
		},
		{
			enabled: !!isActive,
			refetchInterval: 5000, // Check every 5 seconds when active
		},
	);

	// Determine if warning should be shown
	// Show warning only if active but no logs exist yet
	const shouldShowWarning = isActive && (statsLogsCheck?.totalCount ?? 0) === 0;

	useEffect(() => {
		if (logCleanupStatus) {
			setCronExpression(logCleanupStatus.cronExpression || "0 0 * * *");
		}
	}, [logCleanupStatus]);

	const saveCleanup = async () => {
		if (!cronExpression?.trim()) {
			toast.error("Enter a cron expression");
			return;
		}
		try {
			await updateLogCleanup({
				organizationId: active.id,
				cronExpression: cronExpression,
			});
			toast.success("Log cleanup schedule updated");
		} catch (error) {
			toast.error(
				`Failed to update log cleanup schedule: ${errorMessage(error)}`,
			);
		}
	};

	const toggle = (
		<DialogAction
			title={
				isActive ? "Turn off request logging?" : "Turn on request logging?"
			}
			description="Reload Traefik afterwards to apply the change."
			type={isActive ? "destructive" : "default"}
			onClick={async () => {
				await toggleRequests({
					organizationId: active.id,
					enable: !isActive,
				})
					.then(() => {
						toast.success(
							`Request logging ${isActive ? "turned off" : "turned on"}`,
						);
					})
					.catch((err) => {
						toast.error(errorMessage(err));
					});
			}}
		>
			<Button variant={isActive ? "outline" : "default"}>
				{isActive ? "Turn off" : "Turn on"}
			</Button>
		</DialogAction>
	);

	return (
		<div className="flex w-full flex-col gap-6">
			<PageHeader
				title="Requests"
				description="Requests that pass through Traefik to your services."
			>
				{isActive ? (
					<>
						<Button
							variant="outline"
							onClick={() => setDateRange(getDefaultDateRange())}
						>
							Last 3 days
						</Button>
						<Popover>
							<PopoverTrigger
								render={
									<Button
										variant="outline"
										className="justify-start text-left font-normal"
									/>
								}
							>
								<CalendarIcon data-icon="inline-start" />
								{dateRange.from ? (
									dateRange.to ? (
										<>
											{format(dateRange.from, "LLL dd, y")} –{" "}
											{format(dateRange.to, "LLL dd, y")}
										</>
									) : (
										format(dateRange.from, "LLL dd, y")
									)
								) : (
									<span>Pick a date range</span>
								)}
							</PopoverTrigger>
							<PopoverContent className="w-auto p-0" align="end">
								<Calendar
									autoFocus
									mode="range"
									defaultMonth={dateRange.from}
									selected={{
										from: dateRange.from,
										to: dateRange.to,
									}}
									onSelect={(range) => {
										setDateRange({
											from: range?.from,
											to: range?.to,
										});
									}}
									numberOfMonths={2}
								/>
							</PopoverContent>
						</Popover>
					</>
				) : null}
				{isActive ? toggle : null}
			</PageHeader>
			{statusError && <AlertBlock type="error">{statusError}</AlertBlock>}
			{shouldShowWarning && (
				<AlertBlock type="warning">
					Reload Traefik to start collecting requests. You can reload it from{" "}
					<Link href="/settings/general" className="underline">
						Settings
					</Link>
					.
				</AlertBlock>
			)}
			{isActive ? (
				<>
					<RequestDistributionChart dateRange={dateRange} />
					<RequestsTable dateRange={dateRange} />
				</>
			) : isActive === false ? (
				<EmptyState
					icon={ActivityIcon}
					title="Request logging is off"
					description="Turn it on to see traffic and every request Traefik routes. Reload Traefik afterwards for it to take effect."
				>
					{toggle}
				</EmptyState>
			) : null}
			{isActive !== undefined ? (
				<section className="flex flex-col gap-3 border-t pt-6">
					<SectionHeader
						title="Log cleanup"
						description="At this time the access log is cut to its last 1,000 entries and Traefik reopens its log files."
					/>
					<div className="flex items-center gap-2">
						<Label htmlFor="cron" className="sr-only">
							Cleanup schedule
						</Label>
						<Input
							id="cron"
							placeholder="0 0 * * *"
							value={cronExpression || ""}
							onChange={(e) => setCronExpression(e.target.value)}
							className="max-w-60 font-mono"
							required
						/>
						<Button onClick={saveCleanup}>Save</Button>
					</div>
				</section>
			) : null}
		</div>
	);
};
