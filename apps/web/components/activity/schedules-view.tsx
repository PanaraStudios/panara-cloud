"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import {
	useMutation,
	usePaginatedQuery,
	useQueries,
	useQuery,
} from "convex/react";
import { ClockIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { HandleSchedules } from "@/components/dashboard/application/schedules/handle-schedules";
import { FootNote, StatusText } from "@/components/servers/server-ui";
import { Toolbar, ToolbarSearch } from "@/components/shared/list-toolbar";
import { Segmented } from "@/components/shared/segmented";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	EmptyState,
	MoreMenu,
	PageHeader,
	ResourceTable,
	Th,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { ActivityPage, TwoLine } from "./activity-ui";
import {
	describeCron,
	formatWhen,
	PANEL_HOST,
	runDuration,
	runLabel,
	runTone,
	type Schedule,
	type ScheduleRun,
	scheduleTarget,
} from "./schedule-helpers";
import { formatShortDuration, useDirectory } from "./use-directory";

const PAGE = 200;

type Filter = "all" | "services" | "hosts" | "failing";

const scheduleHref = (id: string) => `/activity/schedules/${id}`;

function ScheduleRowView({
	schedule,
	lastRun,
	directory,
}: {
	schedule: Schedule;
	lastRun: ScheduleRun | null | undefined;
	directory: ReturnType<typeof useDirectory>;
}) {
	const permissions = usePermissions();
	const setEnabled = useMutation(api.platform.schedules.setEnabled);
	const runNow = useMutation(api.platform.schedules.runNow);
	const [starting, setStarting] = useState(false);
	const target = scheduleTarget(schedule, directory);
	const human = describeCron(schedule.cronExpression);
	const id = schedule._id as Id<"schedules">;
	const duration = lastRun ? runDuration(lastRun) : null;
	return (
		<TableRow>
			<TableCell className="max-w-0">
				<TwoLine
					primary={
						<Link
							href={scheduleHref(schedule._id)}
							className="font-medium hover:underline"
						>
							{schedule.name}
						</Link>
					}
					secondary={
						<span className="font-mono text-[12px]">
							{schedule.command ||
								(target.isHost ? `${schedule.shellType} script` : "—")}
						</span>
					}
				/>
			</TableCell>
			<TableCell className="max-w-0">
				<TwoLine
					primary={
						target.href ? (
							<Link href={target.href} className="hover:underline">
								{target.label}
							</Link>
						) : (
							target.label
						)
					}
					secondary={target.note}
				/>
			</TableCell>
			<TableCell>
				<TwoLine
					primary={human ?? "Custom"}
					secondary={
						<span className="font-mono text-[12px]">
							{schedule.cronExpression}
						</span>
					}
				/>
			</TableCell>
			<TableCell className="max-w-0">
				{!schedule.enabled && !lastRun ? (
					<span className="text-muted-foreground">Paused</span>
				) : lastRun === undefined ? (
					<Skeleton className="h-4 w-28" />
				) : lastRun === null ? (
					<span className="text-muted-foreground">Never ran</span>
				) : (
					<TwoLine
						primary={
							<StatusText
								tone={runTone(lastRun.status)}
								label={runLabel(lastRun.status)}
								note={formatWhen(lastRun.createdAt)}
							/>
						}
						secondary={
							lastRun.status === "failed" && lastRun.error
								? lastRun.error
								: duration !== null
									? formatShortDuration(duration)
									: null
						}
					/>
				)}
			</TableCell>
			<TableCell className="text-muted-foreground">
				{schedule.enabled && schedule.nextRunAt
					? formatWhen(schedule.nextRunAt)
					: "—"}
			</TableCell>
			<TableCell>
				<Switch
					aria-label={schedule.enabled ? "Pause schedule" : "Resume schedule"}
					checked={schedule.enabled}
					disabled={!permissions.schedule.update}
					onCheckedChange={(enabled) =>
						setEnabled({ scheduleId: id, enabled })
							.then(() =>
								toast.success(enabled ? "Schedule resumed" : "Schedule paused"),
							)
							.catch((error) => toast.error(errorMessage(error)))
					}
				/>
			</TableCell>
			<TableCell className="text-right">
				<MoreMenu>
					{permissions.schedule.create ? (
						<DropdownMenuItem
							disabled={starting}
							onClick={() => {
								setStarting(true);
								runNow({ scheduleId: id })
									.then(() => toast.success("Run started"))
									.catch((error) => toast.error(errorMessage(error)))
									.finally(() => setStarting(false));
							}}
						>
							Run now
						</DropdownMenuItem>
					) : null}
					<DropdownMenuItem render={<Link href={scheduleHref(schedule._id)} />}>
						Logs
					</DropdownMenuItem>
				</MoreMenu>
			</TableCell>
		</TableRow>
	);
}

/** Owners and admins add host schedules here; service schedules are
    created in the service's settings. */
function NewHostSchedule({
	onPick,
}: {
	onPick: (target: { id: string; type: "server" | "panel" }) => void;
}) {
	const { active } = useOrganization();
	const servers = useQuery(api.servers.list, { organizationId: active.id });
	const isInstanceAdmin = useQuery(api.infra.webServer.isInstanceAdmin, {});
	const hosts = [
		...(isInstanceAdmin
			? [{ id: "panel", name: PANEL_HOST, type: "panel" }]
			: []),
		...(servers ?? [])
			.filter((server) => server.sshKeyId)
			.map((server) => ({
				id: server._id as string,
				name: server.name,
				type: "server",
			})),
	] as { id: string; name: string; type: "server" | "panel" }[];
	if (hosts.length === 0) return null;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<Button />}>
				<PlusIcon data-icon="inline-start" />
				Host schedule
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Runs on</DropdownMenuLabel>
					{hosts.map((host) => (
						<DropdownMenuItem
							key={host.id}
							autoIcon={false}
							onClick={() => onPick({ id: host.id, type: host.type })}
						>
							{host.name}
						</DropdownMenuItem>
					))}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function SchedulesView() {
	const router = useRouter();
	const { active, canManage } = useOrganization();
	const directory = useDirectory();
	const [search, setSearch] = useState("");
	const [filter, setFilter] = useState<Filter>("all");
	const [creating, setCreating] = useState<{
		id: string;
		type: "server" | "panel";
	} | null>(null);

	useEffect(() => {
		if (!canManage) router.replace("/");
	}, [canManage, router]);

	const { results, status, loadMore } = usePaginatedQuery(
		api.platform.schedules.listForOrganization,
		canManage ? { organizationId: active.id } : "skip",
		{ initialNumItems: PAGE },
	);
	useEffect(() => {
		if (status === "CanLoadMore") loadMore(PAGE);
	}, [status, loadMore]);

	const lastRunQueries = useMemo(
		() =>
			Object.fromEntries(
				results.map((schedule) => [
					schedule._id,
					{
						query: api.platform.schedules.runs,
						args: { scheduleId: schedule._id, limit: 1 },
					},
				]),
			),
		[results],
	);
	const lastRunResults = useQueries(lastRunQueries);
	const lastRunOf = (id: string): ScheduleRun | null | undefined => {
		const value = lastRunResults[id] as ScheduleRun[] | Error | undefined;
		if (value === undefined) return undefined;
		if (value instanceof Error) return null;
		return value[0] ?? null;
	};

	if (!canManage) return null;

	if (creating)
		return (
			<div className="flex w-full max-w-5xl flex-col gap-6 pb-10">
				<PageHeader
					title="New host schedule"
					description="A script that runs as root on the host on a cron schedule."
				/>
				<HandleSchedules
					id={creating.id}
					scheduleType={creating.type}
					onDone={() => setCreating(null)}
				/>
			</div>
		);

	const isHost = (schedule: Schedule) =>
		schedule.target.kind === "server" || schedule.target.kind === "panel";
	const failing = (schedule: Schedule) =>
		lastRunOf(schedule._id)?.status === "failed";
	const query = search.trim().toLowerCase();
	const rows = results.filter((schedule) => {
		if (filter === "services" && isHost(schedule)) return false;
		if (filter === "hosts" && !isHost(schedule)) return false;
		if (filter === "failing" && !failing(schedule)) return false;
		if (!query) return true;
		return [
			schedule.name,
			schedule.command,
			schedule.cronExpression,
			scheduleTarget(schedule, directory).label,
		].some((value) => value.toLowerCase().includes(query));
	});
	const failingCount = results.filter(failing).length;
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

	return (
		<ActivityPage actions={<NewHostSchedule onPick={setCreating} />}>
			<div className="flex flex-col gap-4">
				<Toolbar>
					<ToolbarSearch
						value={search}
						onChange={setSearch}
						placeholder="Search schedules…"
					/>
					<Segmented
						aria-label="Show"
						value={filter}
						onValueChange={setFilter}
						items={[
							{ value: "all", label: "All", count: results.length },
							{
								value: "services",
								label: "Services",
								count: results.filter((item) => !isHost(item)).length,
							},
							{
								value: "hosts",
								label: "Servers",
								count: results.filter(isHost).length,
							},
							{
								value: "failing",
								label: "Failing",
								count: failingCount,
								tone: failingCount > 0 ? "destructive" : undefined,
							},
						]}
					/>
					<span className="ml-auto text-muted-foreground text-sm">
						Times in {timezone}
					</span>
				</Toolbar>
				{status === "LoadingFirstPage" ? (
					<Skeleton className="h-48 w-full rounded-xl" />
				) : results.length === 0 ? (
					<EmptyState
						icon={ClockIcon}
						title="No schedules yet"
						description="Add one in a service's Settings › Schedules, or run a script on a server on a cron schedule."
					/>
				) : (
					<>
						<ResourceTable
							headers={
								<>
									<Th className="w-[26%]">Schedule</Th>
									<Th className="w-[18%]">Runs on</Th>
									<Th className="w-44">When</Th>
									<Th>Last run</Th>
									<Th className="w-36">Next</Th>
									<Th className="w-14">
										<span className="sr-only">Enabled</span>
									</Th>
									<Th className="w-12" />
								</>
							}
						>
							{rows.map((schedule) => (
								<ScheduleRowView
									key={schedule._id}
									schedule={schedule}
									lastRun={lastRunOf(schedule._id)}
									directory={directory}
								/>
							))}
							{rows.length === 0 ? (
								<TableRow>
									<TableCell
										colSpan={7}
										className="h-20 text-center text-muted-foreground"
									>
										No schedules match.
									</TableCell>
								</TableRow>
							) : null}
						</ResourceTable>
						<FootNote>
							Service schedules are created in the service's Settings ›
							Schedules. Backups run on their own schedules under each
							database's Backups.
						</FootNote>
					</>
				)}
			</div>
		</ActivityPage>
	);
}
