"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useConvex, useMutation, useQuery } from "convex/react";
import { ArchiveIcon, Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ScheduleRuns } from "@/components/activity/schedule-runs";
import { HandleVolumeBackups } from "@/components/dashboard/application/volume-backups/handle-volume-backups";
import { RestoreVolumeBackups } from "@/components/dashboard/application/volume-backups/restore-volume-backups";
import { volumeOwner } from "@/components/dashboard/application/volume-backups/use-volume-owner";
import { DestinationIcon } from "@/components/icons/service-icons";
import { useService } from "@/components/service/service-context";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
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
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { countLabel, Note, SectionToolbar } from "./kit";
import type { SectionProps } from "./registry";
import { describeCron } from "./schedules";

const RUN_TIMEOUT_MS = 60 * 60 * 1000;

export function VolumeBackupsSection({ kind, id, basics }: SectionProps) {
	const type = kind === "compose" ? "compose" : "application";
	const { service, actions: serviceActions } = useService();
	const { active } = useOrganization();
	const permissions = usePermissions();
	const rows = useQuery(api.databases.volumeBackups.list, {
		owner: volumeOwner(type, id),
	});
	const destinations = useQuery(api.databases.destinations.list, {
		organizationId: active.id,
	});
	const runNow = useMutation(api.databases.volumeBackups.runNow);
	const remove = useMutation(api.databases.volumeBackups.remove);
	const convex = useConvex();
	const [running, setRunning] = useState<Set<string>>(new Set());
	const [selected, setSelected] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<string | null>(null);

	if (rows === undefined) return null;

	const run = async (volumeBackupId: string) => {
		setRunning((prev) => new Set(prev).add(volumeBackupId));
		setSelected(volumeBackupId);
		try {
			const jobId = await runNow({
				volumeBackupId: volumeBackupId as Id<"volumeBackups">,
			});
			if (jobId !== null) await waitForJob(convex, jobId, RUN_TIMEOUT_MS);
			toast.success("Volume backed up");
		} catch (cause) {
			toast.error(errorMessage(cause) || "The backup failed — see its log");
		} finally {
			setRunning((prev) => {
				const next = new Set(prev);
				next.delete(volumeBackupId);
				return next;
			});
		}
	};

	const destinationName = (destinationId: string) =>
		destinations?.find((item) => item._id === destinationId)?.name ??
		"Destination";
	const focus = rows.find((row) => row._id === selected) ?? rows[0] ?? null;
	const canCreate = permissions.volumeBackup.create;

	const actions = (
		<div className="flex items-center gap-2">
			<RestoreVolumeBackups
				id={id}
				type={type}
				serverId={basics.serverId ?? undefined}
				trigger={
					<Button
						variant="ghost"
						disabledReason={serviceActions.volumeBackup.reason}
					>
						Restore…
					</Button>
				}
			/>
			{canCreate ? (
				<HandleVolumeBackups
					id={id}
					volumeBackupType={type}
					trigger={
						<Button variant="outline">
							<PlusIcon data-icon="inline-start" />
							New volume backup
						</Button>
					}
				/>
			) : null}
		</div>
	);

	return (
		<div className="flex flex-col gap-4">
			{rows.length === 0 ? (
				<EmptyState
					icon={ArchiveIcon}
					title="No volume backups"
					description={`Back up uploads or other volume data on a schedule. ${service.name} stops for a few seconds while the volume is read, unless you turn that off.`}
				>
					{actions}
				</EmptyState>
			) : (
				<>
					<SectionToolbar actions={actions}>
						{countLabel(rows.length, "volume backup")}
					</SectionToolbar>
					<ResourceTable
						headers={
							<>
								<Th>Volume</Th>
								<Th>Destination</Th>
								<Th>When</Th>
								<Th className="w-20">Keeps</Th>
								<Th>Last backup</Th>
								<Th />
							</>
						}
					>
						{rows.map((row) => {
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
									)}
								>
									<TableCell>
										<span className="block font-mono text-[13px]">
											{row.volumeName}
										</span>
										<span className="text-muted-foreground text-xs">
											{row.name}
											{row.enabled ? "" : " · paused"}
											{row.turnOff ? " · stops the service" : ""}
										</span>
									</TableCell>
									<TableCell>
										<span className="flex items-center gap-2">
											<DestinationIcon
												destination={destinations?.find(
													(item) => item._id === row.destinationId,
												)}
											/>
											{destinationName(row.destinationId)}
										</span>
										<span className="block pl-6 font-mono text-muted-foreground text-xs">
											{row.prefix || "/"}
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
									</TableCell>
									<TableCell className="tabular-nums">
										{row.keepLatestCount ?? "All"}
									</TableCell>
									<TableCell>
										{isRunning ? (
											<span className="flex items-center gap-2">
												<Loader2Icon className="size-3.5 animate-spin" />
												Backing up
											</span>
										) : last ? (
											<span className="flex items-center gap-2">
												<span
													className={cn(
														"size-2 shrink-0 rounded-full",
														last.status === "succeeded"
															? "bg-success"
															: "bg-destructive",
													)}
												/>
												{relativeTime(last.createdAt)}
												{last.status === "succeeded" ? "" : " · failed"}
											</span>
										) : (
											<span className="text-muted-foreground">Never</span>
										)}
									</TableCell>
									<TableCell onClick={(event) => event.stopPropagation()}>
										<div className="flex items-center justify-end gap-1">
											<Button
												variant="ghost"
												size="sm"
												disabled={isRunning}
												disabledReason={serviceActions.volumeBackup.reason}
												onClick={() => void run(row._id)}
											>
												Run now
											</Button>
											{permissions.volumeBackup.update ? (
												<HandleVolumeBackups
													id={id}
													volumeBackupId={row._id}
													volumeBackupType={type}
													trigger={
														<Button variant="ghost" size="sm">
															Edit
														</Button>
													}
												/>
											) : null}
											{permissions.volumeBackup.delete ? (
												<MoreMenu>
													<DropdownMenuItem
														variant="destructive"
														onClick={() => setDeleting(row._id)}
													>
														<Trash2Icon className="text-muted-foreground" />
														Delete
													</DropdownMenuItem>
												</MoreMenu>
											) : null}
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
						History
						<span className="ml-2 font-mono font-normal text-[13px] text-muted-foreground">
							{focus.volumeName}
						</span>
					</h2>
					<ScheduleRuns
						key={focus._id}
						scheduleId={focus._id}
						type="volumeBackup"
						empty="No backups yet. It runs on its schedule, or now with Run now."
					/>
					<Note>
						Restore… picks a backup file and the volume to restore it into.
					</Note>
				</section>
			) : null}
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(open) => {
					if (!open) setDeleting(null);
				}}
				title="Delete volume backup?"
				description="The schedule stops. Backups already in the destination are kept."
				onConfirm={async () => {
					if (!deleting) return;
					await remove({ volumeBackupId: deleting as Id<"volumeBackups"> });
					toast.success("Volume backup deleted");
					if (selected === deleting) setSelected(null);
					setDeleting(null);
				}}
			/>
		</div>
	);
}
