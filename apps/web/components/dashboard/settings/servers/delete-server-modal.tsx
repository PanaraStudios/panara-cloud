"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { ExternalLink, Loader2, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import {
	type DeletableService,
	DeleteServicesDialog,
} from "@/components/service/delete-services-dialog";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { errorMessage } from "@/lib/auth/errors";
import { rendersNativeButton } from "@/lib/native-button";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { useWaitForJob } from "./host-jobs";

interface Props {
	serverId: string;
	serverName: string;
	children?: React.ReactNode;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	onDeleted?: () => void;
}

const serviceTypeLabel: Record<string, string> = {
	application: "Application",
	compose: "Compose",
	postgres: "Postgres",
	mysql: "MySQL",
	mariadb: "MariaDB",
	mongo: "MongoDB",
	redis: "Redis",
	libsql: "LibSQL",
};

export const DeleteServerModal = ({
	serverId,
	serverName,
	children,
	open: controlledOpen,
	onOpenChange,
	onDeleted,
}: Props) => {
	const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
	const open = controlledOpen ?? uncontrolledOpen;
	const setOpen = onOpenChange ?? setUncontrolledOpen;
	const permissions = usePermissions();
	const [deletingService, setDeletingService] =
		useState<DeletableService | null>(null);
	const rawServices = useQuery(
		api.servers.services,
		open ? { serverId: serverId as Id<"servers"> } : "skip",
	);
	const isLoading = open && rawServices === undefined;
	const services = rawServices?.map((service) => ({
		...service,
		url: `/projects/${service.projectId}/environment/${service.environmentId}/services/${service.type}/${service.id}`,
	}));

	const removeServer = useMutation(api.servers.remove);
	const { active } = useOrganization();
	const vectorTargets = useQuery(
		api.platform.telemetry.vectorStatus,
		open ? { organizationId: active.id } : "skip",
	);
	const setVectorTargetProviders = useMutation(
		api.platform.telemetry.setVectorTargetProviders,
	);
	const waitForJob = useWaitForJob();
	const shipsTelemetry = !!vectorTargets?.some(
		(target) => target.serverId === serverId && target.providerIds.length > 0,
	);

	// Stop the Vector agent before the
	// server (and its SSH access) goes away; a failure only warns.
	const removeVectorAgent = async (): Promise<string | undefined> => {
		if (!shipsTelemetry) return undefined;
		try {
			const { jobId } = await setVectorTargetProviders({
				organizationId: active.id,
				serverId: serverId as Id<"servers">,
				providerIds: [],
			});
			await waitForJob(jobId);
			return undefined;
		} catch (error) {
			return errorMessage(error);
		}
	};
	const [isDeletingServer, setIsDeletingServer] = useState(false);

	const canDelete = (services?.length ?? 0) === 0;

	const handleDeleteServer = async () => {
		setIsDeletingServer(true);
		try {
			const vectorAgentRemovalWarning = await removeVectorAgent();
			await removeServer({ serverId: serverId as Id<"servers"> });
			toast.success(`Server ${serverName} deleted successfully`);
			if (vectorAgentRemovalWarning) {
				toast.error(
					`Couldn't reach this host to remove the Vector logs and metrics agent; if it was deployed it may still be running: ${vectorAgentRemovalWarning}`,
				);
			}
			setOpen(false);
			onDeleted?.();
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setIsDeletingServer(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			{children ? (
				<DialogTrigger
					render={children as React.ReactElement}
					nativeButton={rendersNativeButton(children)}
				/>
			) : null}
			<DialogContent
				className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg max-w-lg"
				finalFocus={false}
			>
				<DialogHeader>
					<DialogTitle>Delete server</DialogTitle>
					<DialogDescription>
						This will permanently delete "{serverName}" and all associated data.
					</DialogDescription>
				</DialogHeader>

				{isLoading ? (
					<div className="flex justify-center py-6">
						<Loader2 className="size-5 animate-spin text-muted-foreground" />
					</div>
				) : canDelete ? (
					<AlertBlock type="info">
						No services are associated with this server. You can delete it
						safely.
					</AlertBlock>
				) : (
					<div className="flex flex-col gap-3">
						<AlertBlock type="warning">
							This server has {services?.length} service
							{services?.length === 1 ? "" : "s"} associated. Delete them before
							removing the server.
						</AlertBlock>
						<div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
							{services?.map((service) => (
								<div
									key={`${service.type}-${service.id}`}
									className="flex items-center justify-between gap-2 rounded-lg border p-2"
								>
									<div className="flex min-w-0 flex-col gap-1">
										<span className="truncate text-sm font-medium">
											{service.name}
										</span>
										<Badge variant="outline" className="w-fit text-xs">
											{serviceTypeLabel[service.type]}
										</Badge>
									</div>
									<div className="flex shrink-0 items-center gap-1">
										<Link href={service.url} target="_blank">
											<Button variant="ghost" size="icon" className="h-8 w-8">
												<ExternalLink className="h-4 w-4" />
											</Button>
										</Link>
										{permissions.service.delete ? (
											<Button
												variant="ghost"
												size="icon"
												aria-label={`Delete ${service.name}`}
												className="h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
												onClick={() => setDeletingService(service)}
											>
												<Trash2 className="h-4 w-4" />
											</Button>
										) : null}
									</div>
								</div>
							))}
						</div>
					</div>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button
						variant="destructive"
						disabled={!canDelete || isDeletingServer}
						onClick={handleDeleteServer}
					>
						Delete Server
					</Button>
				</DialogFooter>
			</DialogContent>
			<DeleteServicesDialog
				open={deletingService !== null}
				onOpenChange={(next) => {
					if (!next) setDeletingService(null);
				}}
				services={deletingService ? [deletingService] : []}
			/>
		</Dialog>
	);
};
