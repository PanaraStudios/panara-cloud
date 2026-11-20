"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeftIcon, ClockIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useJobLogs } from "@/components/dashboard/application/deployments/use-deployments";
import { HandleSchedules } from "@/components/dashboard/application/schedules/handle-schedules";
import { DarkWell, FootNote } from "@/components/servers/server-ui";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
	ConfirmDialog,
	MoreMenu,
	NotFoundState,
	PageHeader,
	StatCell,
	StatStrip,
	ToneBadge,
	toneDotClassName,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import {
	describeCron,
	formatRunTime,
	formatWhen,
	runDuration,
	runLabel,
	runTone,
	type Schedule,
	type ScheduleRun,
	scheduleFormId,
	scheduleFormType,
	scheduleTarget,
} from "./schedule-helpers";
import { formatShortDuration, useDirectory } from "./use-directory";

const RUNS = 50;

const lineTone = (line: string) =>
	/\b(fatal|error|failed|killed|panic)\b/i.test(line)
		? "text-danger"
		: /\bwarn(ing)?\b/i.test(line)
			? "text-warning"
			: undefined;

function download(name: string, text: string) {
	const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
	URL.revokeObjectURL(url);
}

function RunLog({ run, name }: { run: ScheduleRun; name: string }) {
	const { text, isLoading } = useJobLogs(run.jobId);
	const lines = useMemo(() => {
		const all = (text || "").replace(/\n$/, "").split("\n");
		return all.length === 1 && all[0] === "" ? [] : all;
	}, [text]);
	const duration = runDuration(run);
	return (
		<div className="flex min-w-0 flex-1 flex-col gap-2">
			<div className="flex min-h-7 flex-wrap items-center gap-x-5 gap-y-1 text-muted-foreground text-sm">
				<span>
					Started{" "}
					<span className="text-foreground">
						{new Date(run.startedAt ?? run.createdAt).toLocaleTimeString()}
					</span>
				</span>
				<span>
					Status{" "}
					<span
						className={cn(
							"text-foreground",
							run.status === "failed" && "text-destructive",
						)}
					>
						{runLabel(run.status)}
					</span>
				</span>
				{duration !== null ? (
					<span>
						Took{" "}
						<span className="text-foreground">
							{formatShortDuration(duration)}
						</span>
					</span>
				) : null}
				{text ? (
					<Button
						variant="outline"
						size="sm"
						className="ml-auto"
						onClick={() =>
							download(
								`${name}-${new Date(run.createdAt).toISOString()}.log`,
								text,
							)
						}
					>
						Download
					</Button>
				) : null}
			</div>
			<DarkWell className="h-[calc(100svh-15rem)] min-h-80 overflow-auto px-5 py-4">
				{lines.length === 0 ? (
					<p className="text-terminal-foreground/50">
						{isLoading
							? "Loading log…"
							: run.status === "queued"
								? "Waiting to start…"
								: "No output"}
					</p>
				) : (
					<pre className="whitespace-pre-wrap break-all">
						{lines.map((line, index) => (
							<div key={index} className={lineTone(line)}>
								{line || " "}
							</div>
						))}
					</pre>
				)}
				{run.status === "failed" && run.error ? (
					<p className="mt-3 text-terminal-foreground/60">
						—— run failed
						{duration !== null ? ` after ${formatShortDuration(duration)}` : ""}
						: {run.error} ——
					</p>
				) : null}
			</DarkWell>
		</div>
	);
}

function RunList({
	runs,
	selected,
	onSelect,
}: {
	runs: ScheduleRun[];
	selected: string | undefined;
	onSelect: (id: string) => void;
}) {
	return (
		<div className="flex w-full shrink-0 flex-col gap-1 lg:w-64">
			<h2 className="flex min-h-7 items-center px-2.5 pb-1 font-semibold text-[15px]">
				Runs
			</h2>
			{runs.map((run) => {
				const duration = runDuration(run);
				const active = run.deploymentId === selected;
				return (
					<button
						key={run.deploymentId}
						type="button"
						aria-current={active ? "true" : undefined}
						onClick={() => onSelect(run.deploymentId)}
						className={cn(
							"flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors hover:bg-muted",
							active && "bg-muted font-medium",
						)}
					>
						<span
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								toneDotClassName(runTone(run.status)),
								run.status === "running" && "animate-pulse",
							)}
						/>
						<span className="min-w-0 flex-1 truncate">
							{formatRunTime(run.createdAt)}
						</span>
						<span className="shrink-0 font-normal text-[13px] text-muted-foreground">
							{duration !== null
								? formatShortDuration(duration)
								: runLabel(run.status)}
						</span>
					</button>
				);
			})}
			<p className="px-2.5 pt-2 text-[13px] text-muted-foreground">
				The last {RUNS} runs are kept.
			</p>
		</div>
	);
}

function Header({
	schedule,
	lastRun,
	onEdit,
}: {
	schedule: Schedule;
	lastRun: ScheduleRun | undefined;
	onEdit: () => void;
}) {
	const router = useRouter();
	const directory = useDirectory();
	const permissions = usePermissions();
	const runNow = useMutation(api.platform.schedules.runNow);
	const remove = useMutation(api.platform.schedules.remove);
	const [deleting, setDeleting] = useState(false);
	const target = scheduleTarget(schedule, directory);
	const human = describeCron(schedule.cronExpression);
	const id = schedule._id as Id<"schedules">;
	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0 space-y-1">
					<Link
						href="/activity/schedules"
						className="-ml-0.5 inline-flex items-center gap-1 text-muted-foreground text-small hover:text-foreground"
					>
						<ArrowLeftIcon aria-hidden className="size-3.5" />
						Schedules
					</Link>
					<div className="flex flex-wrap items-center gap-3">
						<h1 className="text-foreground text-h3">{schedule.name}</h1>
						{!schedule.enabled ? (
							<ToneBadge tone="secondary" label="Paused" />
						) : lastRun ? (
							<ToneBadge
								tone={runTone(lastRun.status)}
								label={`${runLabel(lastRun.status)} · ${formatWhen(lastRun.createdAt)}`}
							/>
						) : null}
					</div>
					{schedule.command ? (
						<p className="truncate font-mono text-[13px] text-muted-foreground">
							{schedule.command}
						</p>
					) : null}
				</div>
				<div className="flex shrink-0 flex-wrap items-center gap-2">
					{permissions.schedule.update ? (
						<Button variant="outline" onClick={onEdit}>
							Edit schedule
						</Button>
					) : null}
					{permissions.schedule.create ? (
						<Button
							onClick={() =>
								runNow({ scheduleId: id })
									.then(() => toast.success("Run started"))
									.catch((error) => toast.error(errorMessage(error)))
							}
						>
							Run now
						</Button>
					) : null}
					{permissions.schedule.delete ? (
						<MoreMenu>
							<DropdownMenuItem
								variant="destructive"
								onClick={() => setDeleting(true)}
							>
								Delete schedule
							</DropdownMenuItem>
						</MoreMenu>
					) : null}
				</div>
			</div>
			<StatStrip>
				<StatCell label="Runs">{human ?? "Custom"}</StatCell>
				<StatCell label="Cron">
					<span className="font-mono text-[13px]">
						{schedule.cronExpression}
					</span>
				</StatCell>
				<StatCell label="Runs on">
					{target.href ? (
						<Link href={target.href} className="truncate hover:underline">
							{target.label}
						</Link>
					) : (
						<span className="truncate">{target.label}</span>
					)}
					{target.note ? (
						<span className="truncate font-normal text-muted-foreground">
							{target.note}
						</span>
					) : null}
				</StatCell>
				<StatCell label="Next run">
					{schedule.enabled && schedule.nextRunAt
						? formatWhen(schedule.nextRunAt)
						: "—"}
				</StatCell>
			</StatStrip>
			<ConfirmDialog
				open={deleting}
				onOpenChange={setDeleting}
				title={`Delete ${schedule.name}?`}
				description="The schedule stops running. Its past runs are deleted with it."
				confirmLabel="Delete schedule"
				onConfirm={async () => {
					await remove({ scheduleId: id });
					toast.success("Schedule deleted");
					router.push("/activity/schedules");
				}}
			/>
		</div>
	);
}

export function ScheduleRunsView({ scheduleId }: { scheduleId: string }) {
	const id = scheduleId as Id<"schedules">;
	const schedule = useQuery(api.platform.schedules.get, { scheduleId: id });
	const runs = useQuery(api.platform.schedules.runs, {
		scheduleId: id,
		limit: RUNS,
	});
	const [picked, setPicked] = useState<string | undefined>();
	const [editing, setEditing] = useState(false);

	if (schedule === undefined) return <Skeleton className="h-96 w-full" />;
	if (schedule === null)
		return (
			<NotFoundState
				icon={ClockIcon}
				noun="schedule"
				backHref="/activity/schedules"
			/>
		);

	if (editing)
		return (
			<div className="flex w-full max-w-5xl flex-col gap-6 pb-10">
				<PageHeader title={`Edit ${schedule.name}`} />
				<HandleSchedules
					id={scheduleFormId(schedule)}
					scheduleId={schedule._id}
					scheduleType={scheduleFormType(schedule)}
					onDone={() => setEditing(false)}
				/>
			</div>
		);

	const current =
		runs?.find((run) => run.deploymentId === picked) ?? runs?.[0] ?? undefined;

	return (
		<div className="flex w-full flex-col gap-6 pb-6">
			<Header
				schedule={schedule}
				lastRun={runs?.[0]}
				onEdit={() => setEditing(true)}
			/>
			{runs === undefined ? (
				<Skeleton className="h-96 w-full" />
			) : runs.length === 0 ? (
				<FootNote className="py-3">
					No runs yet. It runs on its schedule, or now with Run now.
				</FootNote>
			) : (
				<div className="flex flex-col gap-6 lg:flex-row">
					<RunList
						runs={runs}
						selected={current?.deploymentId}
						onSelect={setPicked}
					/>
					{current ? (
						<RunLog
							key={current.deploymentId}
							run={current}
							name={schedule.appName}
						/>
					) : null}
				</div>
			)}
		</div>
	);
}
