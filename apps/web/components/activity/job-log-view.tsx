"use client";

import type { Id } from "@panara-cloud/backend/dataModel";
import { ArrowLeftIcon, ScrollTextIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { LogViewer } from "@/components/dashboard/docker/logs/log-viewer";
import { useLogText } from "@/components/dashboard/docker/logs/use-log-buffer";
import { useJobLogs } from "@/components/dashboard/settings/servers/host-jobs";
import { Button } from "@/components/ui/button";
import {
	type BadgeTone,
	NotFoundState,
	ToneBadge,
} from "@/components/ui-kit/primitives";
import { useShortcut } from "@/lib/dashboard/use-shortcut";
import { useRouter } from "@/lib/router";
import { relativeTime } from "@/lib/time";
import { formatShortDuration } from "./use-directory";

const STATUS: Record<string, { tone: BadgeTone; label: string }> = {
	queued: { tone: "secondary", label: "Queued" },
	running: { tone: "info", label: "Running" },
	succeeded: { tone: "success", label: "Succeeded" },
	failed: { tone: "destructive", label: "Failed" },
	cancelled: { tone: "secondary", label: "Cancelled" },
};

/** `database.restore` reads "Database restore". */
const titleOf = (kind: string) => {
	const words = kind.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._]/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
};

/** The output of one job (a restore, a transfer, a backup run) on a page of
    its own: what a dialog or a drawer used to show while the job ran. */
export function JobLogView({ jobId }: { jobId: string }) {
	const router = useRouter();
	const { job, text, marks } = useJobLogs(jobId as Id<"jobs">);
	const source = useLogText(text, marks);
	const running = job?.status === "running" || job?.status === "queued";
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [running]);
	// Back to where the job was started: a restore under a service, a backup
	// under Settings.
	const back = () => router.back();
	useShortcut("Escape", back);

	if (job === null && text === "") {
		return (
			<NotFoundState
				icon={ScrollTextIcon}
				noun="job"
				backHref="/activity/deployments"
				description="It may have been cleared, or you don't have access to it."
			/>
		);
	}
	const status = job ? STATUS[job.status] : undefined;
	const started = job?.startedAt ?? job?._creationTime;
	const took =
		job?.startedAt !== undefined
			? (job.finishedAt ?? now) - job.startedAt
			: null;
	return (
		<div className="flex w-full flex-col gap-6 pb-10">
			<div className="flex min-w-0 flex-col gap-1">
				<Button
					variant="ghost"
					size="sm"
					autoIcon={false}
					aria-keyshortcuts="Escape"
					className="-ml-2 w-fit text-muted-foreground"
					onClick={back}
				>
					<ArrowLeftIcon data-icon="inline-start" />
					Back
				</Button>
				<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
					<h1 className="min-w-0 truncate font-semibold text-foreground text-xl">
						{job ? titleOf(job.spec.kind) : "Job output"}
					</h1>
					{status ? (
						<ToneBadge tone={status.tone} label={status.label} />
					) : null}
				</div>
				{job ? (
					<p className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-sm">
						{started !== undefined ? (
							<span title={new Date(started).toLocaleString()}>
								{relativeTime(started)}
							</span>
						) : null}
						{took !== null ? (
							<span>
								·{" "}
								{running
									? `running for ${formatShortDuration(took)}`
									: job.status === "failed"
										? `failed after ${formatShortDuration(took)}`
										: `took ${formatShortDuration(took)}`}
							</span>
						) : null}
					</p>
				) : null}
			</div>
			{job?.status === "failed" && job.error ? (
				<div className="flex gap-2 text-sm">
					<span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-destructive" />
					<div className="flex min-w-0 flex-col gap-0.5">
						<p>The job failed.</p>
						<p className="break-words font-mono text-[13px] text-muted-foreground">
							{job.error}
						</p>
					</div>
				</div>
			) : null}
			<LogViewer
				source={source}
				kind="job"
				follow={running}
				resetKey={jobId}
				className="h-[calc(100svh-18rem)] min-h-96"
				fileName={() => `${job?.spec.kind ?? "job"}-${jobId}`}
				empty={
					job?.status === "queued"
						? "Waiting for an agent to pick up this job…"
						: running
							? "Waiting for output…"
							: "No output."
				}
			/>
		</div>
	);
}
