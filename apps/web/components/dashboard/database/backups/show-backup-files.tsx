"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useMutation } from "convex/react";
import { DatabaseBackup, Download, FolderOpen, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/auth/errors";
import { formatBytes } from "./restore-backup";
import { type OpId, useBackupFiles } from "./use-backup-files";

interface Props {
	backupId: string;
	// Panel (web-server) backups live in their own table.
	backupType?: "database" | "web-server";
}

export const ShowBackupFiles = ({
	backupId,
	backupType = "database",
}: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const [opId, setOpId] = useState<OpId | null>(null);
	const [startError, setStartError] = useState<string | null>(null);
	const listFiles = useMutation(api.databases.backups.listFiles);
	const listPanelFiles = useMutation(api.databases.panelBackups.listFiles);
	const getDownloadUrl = useAction(api.databases.downloads.getDownloadUrl);
	const [downloading, setDownloading] = useState<string | null>(null);

	useEffect(() => {
		if (!isOpen) {
			setOpId(null);
			setStartError(null);
			return;
		}
		const start =
			backupType === "web-server"
				? listPanelFiles({ panelBackupId: backupId as Id<"panelBackups"> })
				: listFiles({ backupId: backupId as Id<"databaseBackups"> });
		start
			.then((result) => setOpId(result.opId))
			.catch((error) => setStartError(errorMessage(error)));
	}, [isOpen, backupId, backupType, listFiles, listPanelFiles]);

	const listing = useBackupFiles(opId);
	const files = listing.files;
	const isError = !!startError || listing.isError;
	const error = { message: startError ?? listing.error.message };
	const isLoading = !isError && listing.isPending;

	const download = {
		isPending: downloading !== null,
		variables: downloading === null ? undefined : { fileName: downloading },
		mutate: async ({ fileName }: { fileName: string }) => {
			setDownloading(fileName);
			try {
				const { url } = await getDownloadUrl(
					backupType === "web-server"
						? { panelBackupId: backupId as Id<"panelBackups">, fileName }
						: { backupId: backupId as Id<"databaseBackups">, fileName },
				);
				window.location.assign(url);
			} catch (error) {
				toast.error(errorMessage(error));
			} finally {
				setDownloading(null);
			}
		},
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<TooltipProvider delay={0}>
				<Tooltip>
					<TooltipTrigger
						render={
							<DialogTrigger
								render={
									<Button variant="ghost" size="icon" className="size-8" />
								}
							/>
						}
					>
						<FolderOpen className="size-4" />
					</TooltipTrigger>
					<TooltipContent>Backup Files</TooltipContent>
				</Tooltip>
			</TooltipProvider>

			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>Backup Files</DialogTitle>
					<DialogDescription>
						Files stored in the destination for this backup.
					</DialogDescription>
				</DialogHeader>

				{isError && <AlertBlock type="error">{error.message}</AlertBlock>}

				{isLoading && (
					<div className="flex items-center justify-center py-16">
						<Loader2 className="size-5 animate-spin text-muted-foreground" />
					</div>
				)}

				{!isLoading && !isError && files?.length === 0 && (
					<div className="flex flex-col items-center justify-center gap-3 py-16">
						<DatabaseBackup className="size-8 text-muted-foreground" />
						<span className="text-base text-muted-foreground">
							No backup files found yet
						</span>
					</div>
				)}

				{!isError && !!files?.length && (
					<ScrollArea className="h-[60vh]">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>File</TableHead>
									<TableHead>Date</TableHead>
									<TableHead>Size</TableHead>
									<TableHead className="w-16" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{files.map((file) => (
									<TableRow key={file.Name}>
										<TableCell className="font-medium break-all">
											{file.Name}
										</TableCell>
										<TableCell className="whitespace-nowrap text-sm text-muted-foreground">
											{file.ModTime
												? new Date(file.ModTime).toLocaleString()
												: "—"}
										</TableCell>
										<TableCell className="whitespace-nowrap text-sm text-muted-foreground">
											{formatBytes(file.Size)}
										</TableCell>
										<TableCell>
											<Button
												variant="ghost"
												size="icon"
												className="size-8"
												disabled={download.isPending}
												onClick={() => download.mutate({ fileName: file.Name })}
											>
												{download.isPending &&
												download.variables?.fileName === file.Name ? (
													<Loader2 className="size-4 animate-spin" />
												) : (
													<Download className="size-4" />
												)}
											</Button>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</ScrollArea>
				)}
			</DialogContent>
		</Dialog>
	);
};
