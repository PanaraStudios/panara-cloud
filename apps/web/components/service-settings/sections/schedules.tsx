"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useConvex, useMutation, useQuery } from "convex/react";
import {
	ClockIcon,
	HistoryIcon,
	Loader2Icon,
	PauseIcon,
	PencilIcon,
	PlusIcon,
	Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ScheduleRuns } from "@/components/activity/schedule-runs";
import { useService } from "@/components/service/service-context";
import { Button } from "@/components/ui/button";
import {
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	ConfirmDialog,
	EmptyState,
	MoreMenu,
	ResourceTable,
	Th,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { waitForJob } from "@/lib/host-data";
import { serviceSettingsUrl } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import Link from "@/lib/router/link";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useServiceRef } from "../use-service-ref";
import { countLabel, SectionToolbar } from "./kit";
import type { SectionProps } from "./registry";

const RUN_TIMEOUT_MS = 60 * 60 * 1000;
const DAYS = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];

/** Plain words for the common cron shapes; null when it's anything else. */
export function describeCron(expression: string): string | null {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) return null;
	const [minute, hour, dom, month, dow] = parts as [
		string,
		string,
		string,
		string,
		string,
	];
	const pad = (value: string) => value.padStart(2, "0");
	const number = /^\d+$/;
	if (dom !== "*" || month !== "*") return null;
	if (minute === "*" && hour === "*" && dow === "*") return "Every minute";
	const step = minute.match(/^\*\/(\d+)$/);
	if (step && hour === "*" && dow === "*") return `Every ${step[1]} minutes`;
	if (number.test(minute) && hour === "*" && dow === "*")
		return minute === "0" ? "Every hour" : `Every hour at :${pad(minute)}`;
	const hourStep = hour.match(/^\*\/(\d+)$/);
	if (number.test(minute) && hourStep && dow === "*")
		return `Every ${hourStep[1]} hours`;
	if (number.test(minute) && number.test(hour)) {
		const time = `${pad(hour)}:${pad(minute)}`;
		if (dow === "*") return `Every day at ${time}`;
		if (number.test(dow) && Number(dow) < 7)
			return `Every ${DAYS[Number(dow)]} at ${time}`;
		if (dow === "1-5") return `Weekdays at ${time}`;
	}
	return null;
}

function until(timestamp: number) {
	const minutes = Math.round((timestamp - Date.now()) / 60_000);
	if (minutes <= 0) return "now";
	if (minutes < 60) return `in ${minutes} min`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `in ${hours} h`;
	return `in ${Math.round(hours / 24)} days`;
}

function duration(start?: number, end?: number) {
	if (!start || !end) return null;
	const seconds = (end - start) / 1000;
	return seconds < 60
		? `${seconds.toFixed(1)}s`
		: `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function SchedulesSection({ kind, id }: SectionProps) {
	const ref = useServiceRef();
	const { service, actions } = useService();
	const { active } = useOrganization();
	const permissions = usePermissions();
	const schedules = useQuery(api.platform.schedules.list, {
		organizationId: active.id,
		kind: kind as "application" | "compose",
		targetId: id,
	});
	const remove = useMutation(api.platform.schedules.remove);
	const runNow = useMutation(api.platform.schedules.runNow);
	const setEnabled = useMutation(api.platform.schedules.setEnabled);
	const convex = useConvex();
	const [running, setRunning] = useState<Set<string>>(new Set());
	const [selected, setSelected] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<string | null>(null);

	const run = async (scheduleId: string) => {
		setRunning((prev) => new Set(prev).add(scheduleId));
		setSelected(scheduleId);
		try {
			const jobId = await runNow({ scheduleId: scheduleId as Id<"schedules"> });
			const failed =
				jobId !== null &&
				(await waitForJob(convex, jobId, RUN_TIMEOUT_MS).then(
					() => false,
					() => true,
				));
			if (failed) toast.error("The run failed — its output is below");
			else toast.success("Schedule ran");
		} catch (cause) {
			toast.error(errorMessage(cause));
		} finally {
			setRunning((prev) => {
				const next = new Set(prev);
				next.delete(scheduleId);
				return next;
			});
		}
	};

	if (schedules === undefined || !ref) return null;

	const add = permissions.schedule.create ? (
		<Button
			variant="outline"
			nativeButton={false}
			render={<Link href={serviceSettingsUrl(ref, "schedules/new")} />}
		>
			<PlusIcon data-icon="inline-start" />
			New schedule
		</Button>
	) : null;

	// Below the table: the picked schedule's runs, or the latest failure.
	const lastFailure = [...schedules]
		.filter((row) => row.recentRuns[0]?.status === "failed")
		.sort(
			(a, b) =>
				(b.recentRuns[0]?.createdAt ?? 0) - (a.recentRuns[0]?.createdAt ?? 0),
		)[0];
	const focus =
		schedules.find((row) => row._id === selected) ?? lastFailure ?? null;

	return (
		<div className="flex flex-col gap-4">
			{schedules.length === 0 ? (
				<EmptyState
					icon={ClockIcon}
					title="No schedules"
					description={`Run migrations, cleanups or reports inside ${service.name}'s container on a cron schedule.`}
				>
					{add}
				</EmptyState>
			) : (
				<>
					<SectionToolbar actions={add}>
						<span>{countLabel(schedules.length, "schedule")}</span>
						<span aria-hidden>·</span>
						<span>
							Runs also appear in{" "}
							<Link
								href="/activity/schedules"
								className="text-foreground underline-offset-4 hover:underline"
							>
								Activity › Schedules
							</Link>
						</span>
					</SectionToolbar>
					<ResourceTable
						headers={
							<>
								<Th>Name</Th>
								<Th>When</Th>
								<Th className="max-md:hidden">Command</Th>
								<Th>Last run</Th>
								<Th className="max-lg:hidden">Next</Th>
								<Th />
							</>
						}
					>
						{schedules.map((row) => {
							const last = row.recentRuns[0];
							const isRunning =
								running.has(row._id) ||
								last?.status === "running" ||
								last?.status === "queued";
							const words = describeCron(row.cronExpression);
							return (
								<TableRow
									key={row._id}
									onClick={() => setSelected(row._id)}
									className={cn(
										"cursor-pointer",
										!row.enabled && "text-muted-foreground",
										focus?._id === row._id && selected && "bg-muted/50",
									)}
								>
									<TableCell>
										<span className="block font-medium">{row.name}</span>
										<span className="text-muted-foreground text-xs">
											{row.shellType} · {row.enabled ? "enabled" : "paused"}
										</span>
									</TableCell>
									<TableCell>
										{words ? <span className="block">{words}</span> : null}
										<span
											className={cn(
												"font-mono",
												words ? "text-muted-foreground text-xs" : "text-[13px]",
											)}
										>
											{row.cronExpression}
										</span>
										{row.timezone ? (
											<span className="text-muted-foreground text-xs">
												{" "}
												· {row.timezone}
											</span>
										) : null}
									</TableCell>
									<TableCell className="max-w-64 max-md:hidden">
										<span className="line-clamp-2 break-all font-mono text-[13px]">
											{row.command}
										</span>
									</TableCell>
									<TableCell>
										{isRunning ? (
											<span className="flex items-center gap-2">
												<Loader2Icon className="size-3.5 animate-spin" />
												Running
											</span>
										) : last ? (
											<span
												className="flex items-center gap-2"
												title={new Date(last.createdAt).toLocaleString()}
											>
												<span
													className={cn(
														"size-2 shrink-0 rounded-full",
														last.status === "succeeded"
															? "bg-success"
															: last.status === "failed"
																? "bg-destructive"
																: "bg-muted-foreground",
													)}
												/>
												{last.status === "succeeded"
													? "Succeeded"
													: last.status === "failed"
														? "Failed"
														: "Cancelled"}
												{duration(last.startedAt, last.finishedAt)
													? ` · ${duration(last.startedAt, last.finishedAt)}`
													: ` · ${relativeTime(last.createdAt)}`}
											</span>
										) : (
											<span className="text-muted-foreground">Never ran</span>
										)}
									</TableCell>
									<TableCell className="text-muted-foreground max-lg:hidden">
										{row.enabled && row.nextRunAt ? until(row.nextRunAt) : "—"}
									</TableCell>
									<TableCell onClick={(event) => event.stopPropagation()}>
										<div className="flex items-center justify-end gap-1">
											{row.enabled ? (
												<Button
													variant="ghost"
													size="sm"
													disabled={isRunning}
													disabledReason={actions.runSchedule.reason}
													onClick={() => void run(row._id)}
												>
													Run now
												</Button>
											) : permissions.schedule.update ? (
												<Button
													variant="ghost"
													size="sm"
													onClick={() =>
														setEnabled({ scheduleId: row._id, enabled: true })
															.then(() => toast.success("Schedule resumed"))
															.catch((cause) =>
																toast.error(errorMessage(cause)),
															)
													}
												>
													Resume
												</Button>
											) : null}
											<MoreMenu>
												<DropdownMenuItem onClick={() => setSelected(row._id)}>
													<HistoryIcon className="text-muted-foreground" />
													Run history
												</DropdownMenuItem>
												{permissions.schedule.update ? (
													<>
														<DropdownMenuItem
															render={
																<Link
																	href={serviceSettingsUrl(
																		ref,
																		`schedules/${row._id}`,
																	)}
																/>
															}
														>
															<PencilIcon className="text-muted-foreground" />
															Edit
														</DropdownMenuItem>
														{row.enabled ? (
															<DropdownMenuItem
																onClick={() =>
																	setEnabled({
																		scheduleId: row._id,
																		enabled: false,
																	})
																		.then(() =>
																			toast.success("Schedule paused"),
																		)
																		.catch((cause) =>
																			toast.error(errorMessage(cause)),
																		)
																}
															>
																<PauseIcon className="text-muted-foreground" />
																Pause
															</DropdownMenuItem>
														) : null}
													</>
												) : null}
												{permissions.schedule.delete ? (
													<>
														<DropdownMenuSeparator />
														<DropdownMenuItem
															variant="destructive"
															onClick={() => setDeleting(row._id)}
														>
															<Trash2Icon className="text-muted-foreground" />
															Delete
														</DropdownMenuItem>
													</>
												) : null}
											</MoreMenu>
										</div>
									</TableCell>
								</TableRow>
							);
						})}
					</ResourceTable>
				</>
			)}
			{focus ? (
				<section className="flex flex-col gap-3 pt-4">
					<h2 className="font-semibold text-[15px]">
						{selected ? "Runs" : "Last failure"}
						<span className="ml-2 font-normal text-muted-foreground text-sm">
							{focus.name}
						</span>
					</h2>
					<ScheduleRuns key={focus._id} scheduleId={focus._id} />
				</section>
			) : null}
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(open) => {
					if (!open) setDeleting(null);
				}}
				title="Delete schedule?"
				description="The schedule stops running. Its past runs are deleted with it."
				onConfirm={async () => {
					if (!deleting) return;
					await remove({ scheduleId: deleting as Id<"schedules"> });
					toast.success("Schedule deleted");
					if (selected === deleting) setSelected(null);
					setDeleting(null);
				}}
			/>
		</div>
	);
}
