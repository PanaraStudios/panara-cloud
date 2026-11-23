"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { ClipboardList, DatabaseBackup, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	MariadbIcon,
	MongodbIcon,
	MysqlIcon,
	PostgresqlIcon,
} from "@/components/icons/data-tools-icons";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { EmptyState } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import Link from "@/lib/router/link";
import { cn } from "@/lib/utils";
import { ShowDeploymentsModal } from "../../application/deployments/show-deployments-modal";
import { useDatabase } from "../use-database";
import { HandleBackup } from "./handle-backup";
import { RestoreBackup } from "./restore-backup";
import { ShowBackupFiles } from "./show-backup-files";

type BackupDatabaseType = "postgres" | "mysql" | "mariadb" | "mongo" | "libsql";

interface Props {
	id: string;
	databaseType?: BackupDatabaseType | "web-server";
	backupType?: "database" | "compose";
	// On a page that already carries the "Backups" title: no card, no heading.
	embedded?: boolean;
}
export const ShowBackups = ({
	id,
	databaseType,
	backupType = "database",
	embedded = false,
}: Props) => {
	const [activeManualBackup, setActiveManualBackup] = useState<
		string | undefined
	>();
	const { active } = useOrganization();
	const isPanel = backupType === "database" && databaseType === "web-server";
	const database = useDatabase(
		backupType === "database" && !isPanel ? id : undefined,
	);
	const compose = useQuery(
		api.compose.crud.one,
		backupType === "compose" ? { composeId: id as Id<"compose"> } : "skip",
	);
	const owner =
		backupType === "compose"
			? { kind: "compose" as const, id }
			: { kind: "database" as const, id };
	const serviceBackups = useQuery(
		api.databases.backups.list,
		isPanel || !id ? "skip" : { owner },
	);
	const panelBackups = useQuery(
		api.databases.panelBackups.list,
		isPanel ? {} : "skip",
	);
	const destinations = useQuery(api.databases.destinations.list, {
		organizationId: active.id,
	});
	const data = destinations?.map((destination) => ({
		...destination,
		destinationId: destination._id,
	}));
	const destinationName = (destinationId: string) =>
		destinations?.find((destination) => destination._id === destinationId)
			?.name ?? "";

	const rows = isPanel
		? panelBackups?.map((backup) => ({
				backupId: backup._id as string,
				backupType: "database" as const,
				databaseType: "web-server" as const,
				serviceName: undefined as string | undefined,
				enabled: backup.enabled,
				destination: { name: destinationName(backup.destinationId) },
				database: "panara-cloud",
				schedule: backup.cronExpression,
				prefix: backup.prefix,
				customName: undefined as string | undefined,
				keepLatestCount: backup.keepLatestCount,
			}))
		: serviceBackups?.map((backup) => ({
				backupId: backup._id as string,
				backupType:
					backup.owner.kind === "compose"
						? ("compose" as const)
						: ("database" as const),
				databaseType: backup.databaseType,
				serviceName: backup.serviceName,
				enabled: backup.enabled,
				destination: { name: destinationName(backup.destinationId) },
				database: backup.database,
				schedule: backup.cronExpression,
				prefix: backup.prefix,
				customName: backup.customName,
				keepLatestCount: backup.keepLatestCount,
			}));
	const serverId =
		backupType === "compose" ? compose?.serverId : database?.serverId;
	const postgres = rows ? { backups: rows, serverId } : undefined;

	const runBackup = useMutation(api.databases.backups.runNow);
	const runPanelBackup = useMutation(api.databases.panelBackups.runNow);
	const [isManualBackup, setIsManualBackup] = useState(false);
	const manualBackup = async ({ backupId }: { backupId: string }) => {
		setIsManualBackup(true);
		try {
			if (isPanel) {
				await runPanelBackup({
					panelBackupId: backupId as Id<"panelBackups">,
				});
			} else {
				await runBackup({ backupId: backupId as Id<"databaseBackups"> });
			}
		} finally {
			setIsManualBackup(false);
		}
	};

	const removeBackup = useMutation(api.databases.backups.remove);
	const removePanelBackup = useMutation(api.databases.panelBackups.remove);
	const [isRemoving, setIsRemoving] = useState(false);
	const deleteBackup = async ({ backupId }: { backupId: string }) => {
		setIsRemoving(true);
		try {
			if (isPanel) {
				await removePanelBackup({
					panelBackupId: backupId as Id<"panelBackups">,
				});
			} else {
				await removeBackup({ backupId: backupId as Id<"databaseBackups"> });
			}
		} finally {
			setIsRemoving(false);
		}
	};

	const Frame = embedded ? EmbeddedFrame : Card;
	const Header = embedded ? EmbeddedHeader : CardHeader;
	const Content = embedded ? EmbeddedFrame : CardContent;
	return (
		<Frame className="bg-background">
			<Header className="flex flex-row items-center flex-wrap gap-4 justify-between">
				{embedded ? (
					backupType === "compose" ? null : (
						<p className="text-sm text-muted-foreground">
							{isPanel
								? "Scheduled backups of the panel's own data to S3 storage."
								: "Scheduled dumps of this database to S3 storage."}
						</p>
					)
				) : (
					<div className="flex flex-col gap-1">
						<CardTitle className="text-xl">Backups</CardTitle>
						<CardDescription>
							Add backups to your database to save the data to a different
							provider.
						</CardDescription>
					</div>
				)}

				{postgres && postgres?.backups?.length > 0 && (
					<div className="flex flex-col lg:flex-row gap-4 w-full lg:w-auto">
						{databaseType !== "web-server" && (
							<HandleBackup
								id={id}
								databaseType={databaseType}
								backupType={backupType}
							/>
						)}
						<RestoreBackup
							id={id}
							databaseType={databaseType}
							backupType={backupType}
							serverId={postgres.serverId}
						/>
					</div>
				)}
			</Header>
			<Content className="flex flex-col gap-4">
				{data?.length === 0 ? (
					embedded ? (
						<EmptyState
							icon={DatabaseBackup}
							title="Add S3 storage first"
							description="Backups are uploaded to an S3-compatible bucket. Add one in Settings, then schedule backups here."
						>
							<Button
								variant="outline"
								nativeButton={false}
								render={<Link href="/settings/s3" />}
							>
								Add S3 storage
							</Button>
						</EmptyState>
					) : (
						<div className="flex flex-col items-center gap-3 min-h-[35vh] justify-center">
							<DatabaseBackup className="size-8 text-muted-foreground" />
							<span className="text-base text-muted-foreground text-center">
								To create a backup it is required to set at least 1 provider.
								Please, go to{" "}
								<Link href="/settings/s3" className="text-foreground">
									S3 Destinations
								</Link>{" "}
								to do so.
							</span>
						</div>
					)
				) : (
					<div className="flex flex-col gap-4 w-full">
						{postgres?.backups.length === 0 ? (
							<div className="flex w-full flex-col items-center justify-center gap-3 pt-10">
								<DatabaseBackup className="size-8 text-muted-foreground" />
								<span className="text-base text-muted-foreground">
									No backups configured
								</span>
								<div className="flex flex-col sm:flex-row gap-4 w-full sm:w-auto">
									<HandleBackup
										id={id}
										databaseType={databaseType}
										backupType={backupType}
									/>
									<RestoreBackup
										id={id}
										databaseType={databaseType}
										backupType={backupType}
										serverId={postgres.serverId}
									/>
								</div>
							</div>
						) : (
							<div className="flex flex-col pt-2 gap-4">
								{backupType === "compose" && (
									<AlertBlock title="Compose Backups">
										Make sure the compose is running before creating a backup.
									</AlertBlock>
								)}
								<div className="flex flex-col gap-6">
									{postgres?.backups.map((backup) => {
										const serverId = postgres.serverId;

										return (
											<div key={backup.backupId}>
												<div className="flex w-full flex-col md:flex-row md:items-start justify-between gap-4 border rounded-lg p-4 hover:bg-muted/50 transition-colors">
													<div className="flex flex-col w-full gap-4">
														<div className="flex items-center gap-3">
															{backup.backupType === "compose" && (
																<div className="flex items-center justify-center size-10 rounded-lg">
																	{backup.databaseType === "postgres" && (
																		<PostgresqlIcon className="size-7" />
																	)}
																	{backup.databaseType === "mysql" && (
																		<MysqlIcon className="size-7" />
																	)}
																	{backup.databaseType === "mariadb" && (
																		<MariadbIcon className="size-7" />
																	)}
																	{backup.databaseType === "mongo" && (
																		<MongodbIcon className="size-7" />
																	)}
																</div>
															)}
															<div className="flex flex-col gap-1">
																{backup.backupType === "compose" && (
																	<div className="flex items-center gap-2">
																		<h3 className="font-medium">
																			{backup.serviceName}
																		</h3>
																		<span className="px-1.5 py-0.5 rounded-full bg-muted text-xs font-medium capitalize">
																			{backup.databaseType}
																		</span>
																	</div>
																)}
																<div className="flex items-center gap-2">
																	<div
																		className={cn(
																			"size-1.5 rounded-full",
																			backup.enabled
																				? "bg-green-500"
																				: "bg-red-500",
																		)}
																	/>
																	<span className="text-xs text-muted-foreground">
																		{backup.enabled ? "Active" : "Inactive"}
																	</span>
																</div>
															</div>
														</div>

														<div className="flex flex-wrap gap-x-8 gap-y-2">
															<div className="min-w-[200px]">
																<span className="text-sm font-medium text-muted-foreground">
																	Destination
																</span>
																<p className="font-medium text-sm mt-0.5">
																	{backup.destination.name}
																</p>
															</div>

															<div className="min-w-[150px]">
																<span className="text-sm font-medium text-muted-foreground">
																	Database
																</span>
																<p className="font-medium text-sm mt-0.5">
																	{backup.database}
																</p>
															</div>

															<div className="min-w-[120px]">
																<span className="text-sm font-medium text-muted-foreground">
																	Schedule
																</span>
																<p className="font-medium text-sm mt-0.5">
																	{backup.schedule}
																</p>
															</div>

															<div className="min-w-[150px]">
																<span className="text-sm font-medium text-muted-foreground">
																	Prefix Storage
																</span>
																<p className="font-medium text-sm mt-0.5">
																	{backup.prefix}
																</p>
															</div>

															{backup.customName && (
																<div className="min-w-[150px]">
																	<span className="text-sm font-medium text-muted-foreground">
																		Custom Name
																	</span>
																	<p className="font-medium text-sm mt-0.5">
																		{backup.customName}
																	</p>
																</div>
															)}

															<div className="min-w-[100px]">
																<span className="text-sm font-medium text-muted-foreground">
																	Keep Latest
																</span>
																<p className="font-medium text-sm mt-0.5">
																	{backup.keepLatestCount || "All"}
																</p>
															</div>
														</div>
													</div>

													<div className="flex flex-row md:flex-col gap-1.5">
														<ShowDeploymentsModal
															id={backup.backupId}
															type="backup"
														>
															<Button
																variant="ghost"
																size="icon"
																className="size-8"
															>
																<ClipboardList className="size-4  transition-colors " />
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
																			className="size-8"
																			isLoading={
																				isManualBackup &&
																				activeManualBackup === backup.backupId
																			}
																			onClick={async () => {
																				setActiveManualBackup(backup.backupId);
																				await manualBackup({
																					backupId: backup.backupId as string,
																				})
																					.then(async () => {
																						toast.success(
																							"Manual Backup Started",
																						);
																					})
																					.catch((error) => {
																						toast.error(
																							"Error creating the manual backup",
																							{
																								description:
																									errorMessage(error),
																							},
																						);
																					});
																				setActiveManualBackup(undefined);
																			}}
																		/>
																	}
																>
																	<Play className="size-4 " />
																</TooltipTrigger>
																<TooltipContent>
																	Run Manual Backup
																</TooltipContent>
															</Tooltip>
														</TooltipProvider>

														<ShowBackupFiles
															backupId={backup.backupId}
															backupType={isPanel ? "web-server" : "database"}
														/>
														<HandleBackup
															backupType={backup.backupType}
															backupId={backup.backupId}
															databaseType={backup.databaseType}
														/>
														<DialogAction
															title="Delete Backup"
															description="Are you sure you want to delete this backup?"
															type="destructive"
															onClick={async () => {
																await deleteBackup({
																	backupId: backup.backupId,
																})
																	.then(() => {
																		toast.success(
																			"Backup deleted successfully",
																		);
																	})
																	.catch((error) => {
																		toast.error("Error deleting backup", {
																			description: errorMessage(error),
																		});
																	});
															}}
														>
															<Button
																variant="ghost"
																size="icon"
																className="group hover:bg-red-500/10 size-8"
																isLoading={isRemoving}
															>
																<Trash2 className="size-4 text-primary group-hover:text-red-500" />
															</Button>
														</DialogAction>
													</div>
												</div>
											</div>
										);
									})}
								</div>
							</div>
						)}
					</div>
				)}
			</Content>
		</Frame>
	);
};

function EmbeddedFrame({
	className: _className,
	children,
}: {
	className?: string;
	children?: React.ReactNode;
}) {
	return <div className="flex flex-col gap-4">{children}</div>;
}

function EmbeddedHeader({
	className,
	children,
}: {
	className?: string;
	children?: React.ReactNode;
}) {
	return <div className={className}>{children}</div>;
}
