"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useConvex, useMutation, useQuery } from "convex/react";
import { ClipboardList, Loader2, Play, PlusIcon, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { ToneBadge } from "@/components/ui-kit/primitives";
import { waitForJob } from "@/lib/host-data";
import { ShowDeploymentsModal } from "../deployments/show-deployments-modal";
import { FormNote, FormSection } from "../form-kit";
import { HandleVolumeBackups } from "./handle-volume-backups";
import { RestoreVolumeBackups } from "./restore-volume-backups";
import { type VolumeBackupServiceType, volumeOwner } from "./use-volume-owner";

// How long to wait for a manual run to finish before reporting it.
const RUN_TIMEOUT_MS = 60 * 60 * 1000;

interface Props {
	id: string;
	type?: VolumeBackupServiceType;
	serverId?: string;
}

export const ShowVolumeBackups = ({
	id,
	type = "application",
	serverId,
}: Props) => {
	const [runningBackups, setRunningBackups] = useState<Set<string>>(new Set());
	const rows = useQuery(
		api.databases.volumeBackups.list,
		id ? { owner: volumeOwner(type, id) } : "skip",
	);
	const isLoadingVolumeBackups = rows === undefined;
	const volumeBackups = rows?.map((row) => ({
		volumeBackupId: row._id as string,
		name: row.name,
		enabled: row.enabled,
		cronExpression: row.cronExpression,
		application: undefined as { serverId?: string } | undefined,
		postgres: undefined as { serverId?: string } | undefined,
		mysql: undefined as { serverId?: string } | undefined,
		mariadb: undefined as { serverId?: string } | undefined,
		mongo: undefined as { serverId?: string } | undefined,
		redis: undefined as { serverId?: string } | undefined,
		compose: { serverId },
	}));
	const deleteMutation = useMutation(api.databases.volumeBackups.remove);
	const [isDeleting, setIsDeleting] = useState(false);
	const deleteVolumeBackup = async (args: { volumeBackupId: string }) => {
		setIsDeleting(true);
		try {
			await deleteMutation({
				volumeBackupId: args.volumeBackupId as Id<"volumeBackups">,
			});
		} finally {
			setIsDeleting(false);
		}
	};
	const runNow = useMutation(api.databases.volumeBackups.runNow);
	const convex = useConvex();

	const handleRunManually = async (volumeBackupId: string) => {
		setRunningBackups((prev) => new Set(prev).add(volumeBackupId));
		try {
			const jobId = await runNow({
				volumeBackupId: volumeBackupId as Id<"volumeBackups">,
			});
			if (jobId !== null) await waitForJob(convex, jobId, RUN_TIMEOUT_MS);
			toast.success("Volume backup run successfully");
		} catch {
			toast.error("Error running volume backup");
		} finally {
			setRunningBackups((prev) => {
				const newSet = new Set(prev);
				newSet.delete(volumeBackupId);
				return newSet;
			});
		}
	};

	return (
		<FormSection
			title="Volume backups"
			description="Copies of Docker volumes, sent to a destination on a schedule."
			actions={
				<>
					<RestoreVolumeBackups id={id} type={type} serverId={serverId} />
					<HandleVolumeBackups
						id={id}
						volumeBackupType={type}
						trigger={
							<Button variant="outline">
								<PlusIcon data-icon="inline-start" />
								Add volume backup
							</Button>
						}
					/>
				</>
			}
		>
			{isLoadingVolumeBackups ? (
				<FormNote className="py-3">Loading…</FormNote>
			) : volumeBackups && volumeBackups.length > 0 ? (
				<ul className="divide-y divide-border border-border border-y">
					{volumeBackups.map((volumeBackup) => {
						const serverId =
							volumeBackup.application?.serverId ||
							volumeBackup.postgres?.serverId ||
							volumeBackup.mysql?.serverId ||
							volumeBackup.mariadb?.serverId ||
							volumeBackup.mongo?.serverId ||
							volumeBackup.redis?.serverId ||
							volumeBackup.compose?.serverId;
						const running = runningBackups.has(volumeBackup.volumeBackupId);
						return (
							<li
								key={volumeBackup.volumeBackupId}
								className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2"
							>
								<div className="min-w-0 space-y-0.5">
									<h3 className="truncate font-medium text-sm">
										{volumeBackup.name}
									</h3>
									<p className="font-mono text-[13px] text-muted-foreground">
										{volumeBackup.cronExpression}
									</p>
								</div>
								<div className="flex items-center gap-1">
									<ToneBadge
										tone={volumeBackup.enabled ? "success" : "secondary"}
										label={volumeBackup.enabled ? "Enabled" : "Disabled"}
									/>
									<ShowDeploymentsModal
										id={volumeBackup.volumeBackupId}
										type="volumeBackup"
										serverId={serverId || undefined}
									>
										<Button variant="ghost" size="icon" aria-label="Show runs">
											<ClipboardList className="size-4" />
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
														aria-label="Run now"
														disabled={running}
														onClick={() =>
															handleRunManually(volumeBackup.volumeBackupId)
														}
													/>
												}
											>
												{running ? (
													<Loader2 className="size-4 animate-spin" />
												) : (
													<Play className="size-4" />
												)}
											</TooltipTrigger>
											<TooltipContent>Run now</TooltipContent>
										</Tooltip>
									</TooltipProvider>
									<HandleVolumeBackups
										volumeBackupId={volumeBackup.volumeBackupId}
										id={id}
										volumeBackupType={type}
									/>
									<DialogAction
										title="Delete volume backup"
										description="Are you sure you want to delete this volume backup?"
										type="destructive"
										onClick={async () => {
											await deleteVolumeBackup({
												volumeBackupId: volumeBackup.volumeBackupId,
											})
												.then(() => {
													toast.success("Volume backup deleted successfully");
												})
												.catch(() => {
													toast.error("Error deleting volume backup");
												});
										}}
									>
										<Button
											variant="ghost"
											size="icon"
											aria-label="Delete volume backup"
											isLoading={isDeleting}
										>
											<Trash2 className="size-4" />
										</Button>
									</DialogAction>
								</div>
							</li>
						);
					})}
				</ul>
			) : (
				<FormNote className="py-3">No volume backups yet.</FormNote>
			)}
		</FormSection>
	);
};
