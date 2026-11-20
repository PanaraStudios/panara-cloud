"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import {
	ArchiveIcon,
	ArchiveRestoreIcon,
	ClockIcon,
	DatabaseBackupIcon,
	HistoryIcon,
	Trash2Icon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { ShowVolumeBackups } from "@/components/dashboard/application/volume-backups/show-volume-backups";
import { HandleBackup } from "@/components/dashboard/database/backups/handle-backup";
import { DestinationIcon, MarkTile } from "@/components/icons/service-icons";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	ConfirmDialog,
	EmptyState,
	MoreMenu,
	ResourceTable,
	Section,
	Th,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import {
	type DatabaseKind,
	isDatabaseKind,
	serviceUrl,
} from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import {
	runDuration,
	runFailed,
	runTone,
	useDatabaseBackups,
} from "./database-overview";
import { SectionNote } from "./overview";
import { useService } from "./service-context";

const CRON_WORDS: Record<string, string> = {
	"0 0 * * *": "Daily at 00:00",
	"@daily": "Daily",
	"@hourly": "Hourly",
	"@weekly": "Weekly",
	"0 * * * *": "Hourly",
};

/** A friendly line for the common cron shapes; the expression stays below. */
export function cronLabel(cron: string) {
	if (CRON_WORDS[cron]) return CRON_WORDS[cron];
	const [minute, hour, dom, month, dow] = cron.trim().split(/\s+/);
	const at =
		minute && hour && /^\d+$/.test(minute) && /^\d+$/.test(hour)
			? `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`
			: null;
	if (at && dom === "*" && month === "*" && dow === "*")
		return `Daily at ${at}`;
	if (at && dom === "*" && month === "*" && dow && /^\d$/.test(dow)) {
		const day = [
			"Sunday",
			"Monday",
			"Tuesday",
			"Wednesday",
			"Thursday",
			"Friday",
			"Saturday",
		][Number(dow) % 7];
		return `Weekly · ${day} ${at}`;
	}
	return "Custom schedule";
}

// A table inside a Section hangs off the section's hairline, so its outer
// cells line up with the title instead of sitting in a box's padding.
const FLUSH_TABLE =
	"[&_td:first-child]:pl-0 [&_td:last-child]:pr-0 [&_th:first-child]:pl-0 [&_th:last-child]:pr-0";

const when = (at: number) =>
	new Date(at).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});

/** Redis: no dumps; its data volume is backed up instead (P-49). */
function RedisBackups() {
	const { service } = useService();
	const permissions = usePermissions();
	return (
		<div className="flex flex-col gap-8">
			<p className="flex max-w-3xl items-start gap-2.5 text-muted-foreground text-sm">
				<ArchiveIcon className="mt-0.5 size-4 shrink-0" />
				<span>
					Redis isn't dumped like other databases. Its{" "}
					<span className="font-mono text-[13px]">/data</span> volume (AOF and
					RDB files) is copied to S3 on a schedule, and restoring a copy brings
					the cache back as it was.
				</span>
			</p>
			{permissions.volumeBackup.read ? (
				<ShowVolumeBackups
					id={service.id}
					type="redis"
					serverId={service.serverId ?? undefined}
				/>
			) : null}
		</div>
	);
}

/** `S/backups` (P-46): schedules with run-now and an on switch, then the
    history of runs across them. */
export function ServiceBackups() {
	const { service } = useService();
	const permissions = usePermissions();
	const { active } = useOrganization();
	const backups = useDatabaseBackups(service.id, permissions.backup.read);
	const destinations = useQuery(api.databases.destinations.list, {
		organizationId: active.id,
	});
	const runNow = useMutation(api.databases.backups.runNow);
	const setEnabled = useMutation(api.databases.backups.setEnabled);
	const remove = useMutation(api.databases.backups.remove);
	const [removing, setRemoving] = useState<string | null>(null);
	const [running, setRunning] = useState<string | null>(null);

	if (!isDatabaseKind(service.kind)) {
		return (
			<EmptyState
				icon={DatabaseBackupIcon}
				title="No database backups for this service"
				description="Volume backups in Settings cover services without a database dump."
			/>
		);
	}
	if (service.kind === "redis") return <RedisBackups />;
	const kind = service.kind as Exclude<DatabaseKind, "redis">;
	const destinationOf = (id: string) => destinations?.find((d) => d._id === id);
	const destinationName = (id: string) => destinationOf(id)?.name ?? "S3";
	const canManage = permissions.backup.create;
	const restoreHref = (backupId: string, run?: string) =>
		`${serviceUrl(service.ref, "backups/restore")}?backup=${backupId}${run ? `&run=${run}` : ""}`;

	if (destinations !== undefined && destinations.length === 0) {
		return (
			<EmptyState
				icon={DatabaseBackupIcon}
				title="Add S3 storage first"
				description="Backups are uploaded to an S3-compatible bucket. Add one in Settings, then schedule backups here."
			>
				<Button
					variant="outline"
					size="sm"
					nativeButton={false}
					render={<Link href="/settings/s3" />}
				>
					Add S3 storage
				</Button>
			</EmptyState>
		);
	}

	const history = (backups ?? [])
		.flatMap((backup) => backup.recentRuns.map((run) => ({ ...run, backup })))
		.sort((a, b) => b.createdAt - a.createdAt);

	const run = async (backupId: string) => {
		setRunning(backupId);
		try {
			await runNow({ backupId: backupId as Id<"databaseBackups"> });
			toast.success("Backup started");
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setRunning(null);
		}
	};

	return (
		<div className="flex flex-col gap-8">
			<Section
				title="Schedules"
				icon={ClockIcon}
				actions={
					<div className="flex items-center gap-2">
						{canManage && backups && backups.length > 0 ? (
							<Button
								variant="outline"
								size="sm"
								isLoading={running === backups[0]?._id}
								onClick={() => backups[0] && run(backups[0]._id)}
							>
								Back up now
							</Button>
						) : null}
						{canManage ? (
							<HandleBackup
								id={service.id}
								databaseType={kind}
								backupType="database"
								label="New schedule"
							/>
						) : null}
					</div>
				}
			>
				{backups === undefined ? (
					<div className="flex flex-col gap-3 py-4" aria-busy="true">
						<Skeleton className="h-4 w-2/3" />
						<Skeleton className="h-4 w-1/2" />
					</div>
				) : backups.length === 0 ? (
					<SectionNote>
						No schedules yet. Add one to dump {service.name} to S3 storage on a
						schedule.
					</SectionNote>
				) : (
					<ResourceTable
						framed={false}
						className={FLUSH_TABLE}
						headers={
							<>
								<Th>Destination</Th>
								<Th>When</Th>
								<Th className="max-md:hidden">Database</Th>
								<Th className="max-lg:hidden">Keeps</Th>
								<Th className="max-sm:hidden">Last run</Th>
								<Th className="w-14">On</Th>
								<Th className="w-28" />
							</>
						}
					>
						{(backups ?? []).map((backup) => {
							const last = backup.recentRuns[0];
							return (
								<TableRow key={backup._id} className="h-[52px]">
									<TableCell>
										<div className="flex min-w-0 items-center gap-3">
											<MarkTile>
												<DestinationIcon
													destination={destinationOf(backup.destinationId)}
												/>
											</MarkTile>
											<div className="flex min-w-0 flex-col">
												<span className="truncate font-medium">
													{destinationName(backup.destinationId)}
												</span>
												<span className="truncate font-mono text-muted-foreground text-xs">
													{backup.prefix || "/"}
												</span>
											</div>
										</div>
									</TableCell>
									<TableCell>
										<div className="flex flex-col">
											<span>{cronLabel(backup.cronExpression)}</span>
											<span className="font-mono text-muted-foreground text-xs">
												{backup.cronExpression}
											</span>
										</div>
									</TableCell>
									<TableCell className="font-mono text-[13px] max-md:hidden">
										{backup.database}
									</TableCell>
									<TableCell className="max-lg:hidden">
										{backup.keepLatestCount ?? "All"}
									</TableCell>
									<TableCell className="max-sm:hidden">
										{last ? (
											<span className="inline-flex items-center gap-2">
												<span
													className={cn(
														"size-1.5 rounded-full",
														runTone(last.status),
													)}
												/>
												{relativeTime(last.createdAt)}
												{runDuration(last) ? ` · ${runDuration(last)}` : ""}
											</span>
										) : (
											<span className="text-muted-foreground">Never</span>
										)}
									</TableCell>
									<TableCell>
										<Switch
											aria-label="Schedule on"
											disabled={!canManage}
											checked={backup.enabled}
											onCheckedChange={(enabled) =>
												setEnabled({
													backupId: backup._id,
													enabled,
												}).catch((error) => toast.error(errorMessage(error)))
											}
										/>
									</TableCell>
									<TableCell className="text-right">
										<div className="flex items-center justify-end gap-1">
											{canManage ? (
												<Button
													variant="outline"
													size="sm"
													isLoading={running === backup._id}
													onClick={() => run(backup._id)}
												>
													Run now
												</Button>
											) : null}
											{canManage ? (
												<HandleBackup
													id={service.id}
													backupId={backup._id}
													databaseType={kind}
													backupType="database"
												/>
											) : null}
											<MoreMenu>
												{permissions.backup.restore ? (
													<DropdownMenuItem
														render={<Link href={restoreHref(backup._id)} />}
													>
														<ArchiveRestoreIcon className="text-muted-foreground" />
														Restore…
													</DropdownMenuItem>
												) : null}
												{canManage ? (
													<DropdownMenuItem
														variant="destructive"
														onClick={() => setRemoving(backup._id)}
													>
														<Trash2Icon className="text-muted-foreground" />
														Delete schedule
													</DropdownMenuItem>
												) : null}
											</MoreMenu>
										</div>
									</TableCell>
								</TableRow>
							);
						})}
					</ResourceTable>
				)}
			</Section>
			<Section
				title="History"
				icon={HistoryIcon}
				hint={
					history.length > 0
						? `${history.length} recent ${history.length === 1 ? "run" : "runs"}`
						: undefined
				}
			>
				{history.length === 0 ? (
					<SectionNote>
						{backups === undefined ? "Loading…" : "No backups have run yet."}
					</SectionNote>
				) : (
					<ResourceTable
						framed={false}
						className={FLUSH_TABLE}
						headers={
							<>
								<Th>When</Th>
								<Th className="max-md:hidden">File</Th>
								<Th className="max-lg:hidden">Destination</Th>
								<Th className="w-16">Took</Th>
								<Th className="w-24" />
							</>
						}
					>
						{history.map((entry) => {
							const failed = runFailed(entry.status);
							return (
								<TableRow key={entry.deploymentId} className="h-11">
									<TableCell>
										<span className="inline-flex items-center gap-2">
											<span
												className={cn(
													"size-1.5 shrink-0 rounded-full",
													runTone(entry.status),
												)}
											/>
											{when(entry.createdAt)}
										</span>
									</TableCell>
									<TableCell className="max-w-96 truncate max-md:hidden">
										{failed ? (
											<span className="text-muted-foreground">
												Failed{entry.error ? ` · ${entry.error}` : ""}
											</span>
										) : (
											<span className="font-mono text-[13px] text-muted-foreground">
												{entry.description ?? entry.title}
											</span>
										)}
									</TableCell>
									<TableCell className="text-muted-foreground max-lg:hidden">
										<span className="flex items-center gap-2">
											<DestinationIcon
												destination={destinationOf(entry.backup.destinationId)}
											/>
											{destinationName(entry.backup.destinationId)}
										</span>
									</TableCell>
									<TableCell className="text-muted-foreground">
										{runDuration(entry) ?? "—"}
									</TableCell>
									<TableCell className="text-right">
										{!failed && permissions.backup.restore ? (
											<Button
												variant="outline"
												size="sm"
												nativeButton={false}
												render={
													<Link
														href={restoreHref(
															entry.backup._id,
															entry.deploymentId,
														)}
													/>
												}
											>
												Restore…
											</Button>
										) : null}
									</TableCell>
								</TableRow>
							);
						})}
					</ResourceTable>
				)}
			</Section>
			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(open) => {
					if (!open) setRemoving(null);
				}}
				title="Delete this schedule?"
				description="Stops future backups. Files already in S3 are kept."
				onConfirm={async () => {
					if (!removing) return;
					try {
						await remove({ backupId: removing as Id<"databaseBackups"> });
						setRemoving(null);
					} catch (error) {
						toast.error(errorMessage(error));
					}
				}}
			/>
		</div>
	);
}
