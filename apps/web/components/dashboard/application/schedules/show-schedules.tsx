"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useConvex, useMutation, useQuery } from "convex/react";
import {
	ClipboardList,
	Clock,
	Loader2,
	Play,
	Terminal,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { waitForJob } from "@/lib/host-data";
import { useOrganization } from "@/lib/organization";
import { ShowDeploymentsModal } from "../deployments/show-deployments-modal";
import { HandleSchedules } from "./handle-schedules";

// How long to wait for a manual run to finish before reporting it.
const RUN_TIMEOUT_MS = 60 * 60 * 1000;

interface Props {
	id: string;
	scheduleType?: "application" | "compose" | "server" | "panel";
}

export const ShowSchedules = ({ id, scheduleType = "application" }: Props) => {
	const [runningSchedules, setRunningSchedules] = useState<Set<string>>(
		new Set(),
	);
	const { active, canManage } = useOrganization();
	const kind =
		scheduleType === "panel"
			? ("panel" as const)
			: (scheduleType as "application" | "compose" | "server");
	const isHost = kind === "server" || kind === "panel";
	const rows = useQuery(
		api.platform.schedules.list,
		(id || kind === "panel") && (!isHost || canManage)
			? {
					organizationId: active.id,
					kind,
					...(kind === "panel" ? {} : { targetId: id }),
				}
			: "skip",
	);
	const isLoadingSchedules = rows === undefined && (!isHost || canManage);
	const schedules = rows?.map((row) => ({
		scheduleId: row._id as string,
		name: row.name,
		description: row.description,
		enabled: row.enabled,
		cronExpression: row.cronExpression,
		shellType: row.shellType,
		command: row.command,
		scheduleType: row.target.kind === "panel" ? "panel" : row.target.kind,
		serverId: row.target.kind === "server" ? row.target.serverId : undefined,
		application: undefined as { serverId?: string } | undefined,
		compose: undefined as { serverId?: string } | undefined,
	}));
	const deleteScheduleMutation = useMutation(api.platform.schedules.remove);
	const [isDeleting, setIsDeleting] = useState(false);
	const deleteSchedule = async (args: { scheduleId: string }) => {
		setIsDeleting(true);
		try {
			await deleteScheduleMutation({
				scheduleId: args.scheduleId as Id<"schedules">,
			});
		} finally {
			setIsDeleting(false);
		}
	};
	const runNow = useMutation(api.platform.schedules.runNow);
	const convex = useConvex();

	const handleRunManually = async (scheduleId: string) => {
		setRunningSchedules((prev) => new Set(prev).add(scheduleId));
		try {
			const jobId = await runNow({ scheduleId: scheduleId as Id<"schedules"> });
			const failed =
				jobId !== null &&
				(await waitForJob(convex, jobId, RUN_TIMEOUT_MS).then(
					() => false,
					() => true,
				));
			if (failed) {
				toast.error("Schedule run failed, check the deployment logs");
			} else {
				toast.success("Schedule run successfully");
			}
		} catch {
			toast.error("Error running schedule");
		} finally {
			setRunningSchedules((prev) => {
				const newSet = new Set(prev);
				newSet.delete(scheduleId);
				return newSet;
			});
		}
	};

	return (
		<section className="flex min-w-0 flex-col gap-4">
			<div className="flex flex-row flex-wrap items-start justify-between gap-3">
				<div className="flex flex-col gap-1">
					<h2 className="font-semibold text-[15px]">Scheduled tasks</h2>
					<p className="text-muted-foreground text-sm">
						Schedule tasks to run automatically at specified intervals.
					</p>
				</div>
				{schedules && schedules.length > 0 && (
					<HandleSchedules id={id} scheduleType={scheduleType} />
				)}
			</div>
			<div>
				{isLoadingSchedules ? (
					<div className="flex gap-4 w-full items-center justify-center text-center mx-auto min-h-[45vh]">
						<Loader2 className="size-4 text-muted-foreground/70 transition-colors animate-spin self-center" />
						<span className="text-sm text-muted-foreground/70">
							Loading scheduled tasks...
						</span>
					</div>
				) : schedules && schedules.length > 0 ? (
					<div className="grid xl:grid-cols-2 gap-4 grid-cols-1 h-full">
						{schedules.map((schedule) => {
							const serverId =
								schedule.serverId ||
								schedule.application?.serverId ||
								schedule.compose?.serverId;
							return (
								<div
									key={schedule.scheduleId}
									className="flex flex-col sm:flex-row sm:items-center flex-wrap sm:flex-nowrap gap-y-2 justify-between rounded-lg border p-3 transition-colors bg-muted/50 w-full"
								>
									<div className="flex items-start gap-3 w-full sm:w-auto">
										<div className="flex shrink-0 h-9 w-9 items-center justify-center rounded-full bg-primary/5">
											<Clock className="size-4 text-primary/70" />
										</div>
										<div className="space-y-1.5 w-full sm:w-auto">
											<div className="flex items-center gap-2 flex-wrap">
												<h3 className="text-sm font-medium leading-none wrap-anywhere line-clamp-3">
													{schedule.name}
												</h3>
												<Badge
													variant={schedule.enabled ? "default" : "secondary"}
													className="text-[10px] px-1 py-0"
												>
													{schedule.enabled ? "Enabled" : "Disabled"}
												</Badge>
											</div>
											{schedule.description && (
												<p className="text-xs text-muted-foreground/70 wrap-anywhere line-clamp-2">
													{schedule.description}
												</p>
											)}
											<div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
												<Badge
													variant="outline"
													className="font-mono text-[10px] bg-transparent"
												>
													Cron: {schedule.cronExpression}
												</Badge>
												{schedule.scheduleType !== "server" &&
													schedule.scheduleType !== "panel" && (
														<>
															<span className="text-xs text-muted-foreground/50">
																•
															</span>
															<Badge
																variant="outline"
																className="font-mono text-[10px] bg-transparent"
															>
																{schedule.shellType}
															</Badge>
														</>
													)}
											</div>
											{schedule.command && (
												<div className="flex items-start gap-2 max-w-full">
													<Terminal className="size-3.5 text-muted-foreground/70 shrink-0 mt-0.5" />
													<code className="font-mono text-[10px] text-muted-foreground/70 break-all max-w-[calc(100%-20px)]">
														{schedule.command}
													</code>
												</div>
											)}
										</div>
									</div>
									<div className="flex items-center gap-0.5 md:gap-1.5">
										<ShowDeploymentsModal
											id={schedule.scheduleId}
											type="schedule"
											serverId={serverId || undefined}
										>
											<Button variant="ghost" size="icon">
												<ClipboardList className="size-4 transition-colors" />
											</Button>
										</ShowDeploymentsModal>
										<TooltipProvider delay={0}>
											<Tooltip>
												<TooltipTrigger
													render={
														<Button
															type="button"
															variant="ghost"
															size="icon"
															disabled={runningSchedules.has(
																schedule.scheduleId,
															)}
															onClick={() =>
																handleRunManually(schedule.scheduleId)
															}
														/>
													}
												>
													{runningSchedules.has(schedule.scheduleId) ? (
														<Loader2 className="size-4 animate-spin" />
													) : (
														<Play className="size-4 transition-colors" />
													)}
												</TooltipTrigger>
												<TooltipContent>Run manual schedule</TooltipContent>
											</Tooltip>
										</TooltipProvider>
										<HandleSchedules
											scheduleId={schedule.scheduleId}
											id={id}
											scheduleType={scheduleType}
										/>
										<DialogAction
											title="Delete Schedule"
											description="Are you sure you want to delete this schedule?"
											type="destructive"
											onClick={async () => {
												await deleteSchedule({
													scheduleId: schedule.scheduleId,
												})
													.then(() => {
														toast.success("Schedule deleted successfully");
													})
													.catch(() => {
														toast.error("Error deleting schedule");
													});
											}}
										>
											<Button variant="ghost" size="icon" disabled={isDeleting}>
												<Trash2 className="size-4 text-muted-foreground" />
											</Button>
										</DialogAction>
									</div>
								</div>
							);
						})}
					</div>
				) : (
					<div className="flex flex-col gap-2 items-center justify-center py-12 rounded-lg">
						<Clock className="size-8 mb-4 text-muted-foreground" />
						<p className="text-lg font-medium text-muted-foreground">
							No scheduled tasks
						</p>
						<p className="text-sm text-muted-foreground mt-1">
							Create your first scheduled task to automate your workflows
						</p>
						<HandleSchedules id={id} scheduleType={scheduleType} />
					</div>
				)}
			</div>
		</section>
	);
};
