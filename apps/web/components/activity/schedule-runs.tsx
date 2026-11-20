"use client";

import type { api } from "@panara-cloud/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useMemo, useState } from "react";
import {
	type Deployment,
	useDeployments,
	useJobLogs,
} from "@/components/dashboard/application/deployments/use-deployments";
import { parseLogs } from "@/components/dashboard/docker/logs/utils";
import { VirtualLogList } from "@/components/dashboard/docker/logs/virtual-log-list";
import { Skeleton } from "@/components/ui/skeleton";
import { toneDotClassName } from "@/components/ui-kit/primitives";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

const runTone = (status: Deployment["status"]) =>
	status === "done"
		? ("success" as const)
		: status === "error"
			? ("destructive" as const)
			: status === "cancelled"
				? ("secondary" as const)
				: ("warning" as const);

const runLabel = (status: Deployment["status"]) =>
	status === "done"
		? "Succeeded"
		: status === "error"
			? "Failed"
			: status === "cancelled"
				? "Cancelled"
				: status === "queued"
					? "Queued"
					: "Running";

function RunLog({ run }: { run: Deployment }) {
	const { text, isLoading } = useJobLogs(run.jobId);
	const lines = useMemo(
		() => parseLogs(text || run.errorMessage || ""),
		[text, run.errorMessage],
	);
	return (
		<VirtualLogList
			logs={lines}
			noTimestamp
			className="h-72 rounded-lg border bg-terminal"
		>
			<div className="flex h-full items-center justify-center text-muted-foreground text-sm">
				{isLoading ? "Loading log…" : "No output"}
			</div>
		</VirtualLogList>
	);
}

/** The last runs of one schedule, with the selected run's log inline. */
export function ScheduleRuns({
	scheduleId,
	type = "schedule",
	empty = "No runs yet. It runs on its schedule, or now with Run now.",
}: {
	scheduleId: string;
	// The runs of a volume backup read the same way.
	type?: "schedule" | "volumeBackup";
	empty?: string;
}) {
	const runs = useDeployments(scheduleId, type);
	const [open, setOpen] = useState<string | null>(null);
	useEffect(() => {
		if (open === null && runs?.[0]) setOpen(runs[0].deploymentId);
	}, [open, runs]);
	if (runs === undefined) return <Skeleton className="h-16 w-full" />;
	if (runs.length === 0)
		return <p className="py-2 text-small text-muted-foreground">{empty}</p>;
	const current = runs.find((run) => run.deploymentId === open);
	return (
		<div className="flex flex-col gap-3 py-1">
			<ul className="flex flex-col">
				{runs.slice(0, 10).map((run) => (
					<li key={run.deploymentId}>
						<button
							type="button"
							onClick={() => setOpen(run.deploymentId)}
							className={cn(
								"flex h-8 w-full items-center gap-3 rounded-md px-2 text-left text-small hover:bg-muted",
								run.deploymentId === open && "bg-muted",
							)}
						>
							<span
								className={cn(
									"size-1.5 shrink-0 rounded-full",
									toneDotClassName(runTone(run.status)),
								)}
							/>
							<span className="w-24 shrink-0">{runLabel(run.status)}</span>
							<span className="min-w-0 flex-1 truncate text-muted-foreground">
								{run.title}
							</span>
							<span className="shrink-0 text-muted-foreground">
								{relativeTime(new Date(run.createdAt).getTime())}
							</span>
						</button>
					</li>
				))}
			</ul>
			{current ? <RunLog run={current} /> : null}
		</div>
	);
}

type ScheduleRow = FunctionReturnType<
	typeof api.platform.schedules.list
>[number];
