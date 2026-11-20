"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { Loader2, MoreHorizontal, RefreshCw } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { toast } from "sonner";
import { ShowContainerConfig } from "@/components/dashboard/docker/config/show-container-config";
import { ShowContainerMounts } from "@/components/dashboard/docker/mounts/show-container-mounts";
import { ShowContainerNetworks } from "@/components/dashboard/docker/networks/show-container-networks";
import { DockerTerminalModal } from "@/components/dashboard/docker/terminal/docker-terminal-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { composeIdOf, useComposeContainers } from "../use-compose";

const DockerLogsId = dynamic(
	() =>
		import("@/components/dashboard/docker/logs/docker-logs-id").then(
			(e) => e.DockerLogsId,
		),
	{
		ssr: false,
	},
);

interface Props {
	appName: string;
	serverId?: string;
	appType: "stack" | "docker-compose";
	serviceId?: string;
}

export const ShowComposeContainers = ({
	appName,
	appType,
	serverId,
	serviceId,
}: Props) => {
	const { data, isPending, isRefreshing, refetch } = useComposeContainers(
		serviceId,
		{ enabled: !!appName },
	);

	return (
		<section className="flex min-w-0 flex-col gap-4">
			<div className="flex flex-row flex-wrap items-start justify-between gap-3">
				<div>
					<h2 className="font-semibold text-[15px]">Containers</h2>
					<p className="text-muted-foreground text-sm">
						Inspect each container in this compose and run basic lifecycle
						actions.
					</p>
				</div>
				<Button
					variant="outline"
					size="icon"
					onClick={() => refetch()}
					disabled={isPending || isRefreshing}
				>
					<RefreshCw
						className={`h-4 w-4 ${isPending || isRefreshing ? "animate-spin" : ""}`}
					/>
				</Button>
			</div>
			<div>
				{isPending ? (
					<div className="flex items-center justify-center h-[20vh]">
						<Loader2 className="animate-spin h-6 w-6 text-muted-foreground" />
					</div>
				) : !data || data.length === 0 ? (
					<div className="flex items-center justify-center h-[20vh]">
						<span className="text-muted-foreground">
							No containers found. Deploy the compose to see containers here.
						</span>
					</div>
				) : (
					<div className="rounded-md border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Name</TableHead>
									<TableHead>State</TableHead>
									<TableHead>Status</TableHead>
									{appType === "stack" && <TableHead>Node</TableHead>}
									<TableHead>Container ID</TableHead>
									<TableHead className="text-right" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.map((container) => (
									<ContainerRow
										key={container.name}
										container={container}
										appType={appType}
										serverId={serverId}
										serviceId={serviceId}
										onActionComplete={() => refetch()}
									/>
								))}
							</TableBody>
						</Table>
					</div>
				)}
			</div>
		</section>
	);
};

interface ContainerRowProps {
	container: {
		containerId: string;
		name: string;
		state: string;
		status: string;
		node?: string;
	};
	appType: "stack" | "docker-compose";
	serverId?: string;
	serviceId?: string;
	onActionComplete: () => void;
}

const ContainerRow = ({
	container,
	appType,
	serverId,
	serviceId,
	onActionComplete,
}: ContainerRowProps) => {
	const [logsOpen, setLogsOpen] = useState(false);
	const [actionLoading, setActionLoading] = useState<string | null>(null);

	const runAction = useMutation(api.compose.containers.runAction);

	const handleAction = async (
		action: "restart" | "start" | "stop" | "kill",
	) => {
		if (!serviceId) return;
		setActionLoading(action);
		try {
			await runAction({
				composeId: composeIdOf(serviceId),
				containerId: container.containerId,
				action,
			});
			toast.success(`Container ${action} successfully`);
			onActionComplete();
		} catch (error) {
			toast.error(
				`Failed to ${action} container: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		} finally {
			setActionLoading(null);
		}
	};

	return (
		<TableRow>
			<TableCell className="font-medium">{container.name}</TableCell>
			<TableCell>
				<Badge
					variant={
						container.state === "running"
							? "default"
							: [
										"exited",
										"pending",
										"preparing",
										"starting",
										"ready",
									].includes(container.state)
								? "secondary"
								: "destructive"
					}
				>
					{container.state}
				</Badge>
			</TableCell>
			<TableCell>{container.status}</TableCell>
			{appType === "stack" && <TableCell>{container.node || "-"}</TableCell>}
			<TableCell className="font-mono text-sm text-muted-foreground">
				{container.containerId || "-"}
			</TableCell>
			<TableCell className="text-right">
				{!container.containerId ? null : (
					<Dialog open={logsOpen} onOpenChange={setLogsOpen}>
						<DropdownMenu>
							<DropdownMenuTrigger
								render={<Button variant="ghost" className="h-8 w-8 p-0" />}
							>
								{actionLoading ? (
									<Loader2 className="h-4 w-4 animate-spin" />
								) : (
									<MoreHorizontal className="h-4 w-4" />
								)}
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuGroup>
									<DropdownMenuLabel>Actions</DropdownMenuLabel>
								</DropdownMenuGroup>
								<DialogTrigger
									role="menuitem"
									render={
										<DropdownMenuItem
											className="cursor-pointer"
											closeOnClick={false}
										/>
									}
									nativeButton={false}
								>
									View logs
								</DialogTrigger>
								<ShowContainerConfig
									containerId={container.containerId}
									serverId={serverId || ""}
								/>
								<ShowContainerMounts
									containerId={container.containerId}
									serverId={serverId || ""}
								/>
								<ShowContainerNetworks
									containerId={container.containerId}
									serverId={serverId || ""}
								/>
								<DockerTerminalModal
									containerId={container.containerId}
									serverId={serverId || ""}
									serviceId={serviceId}
								>
									Terminal
								</DockerTerminalModal>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									className="cursor-pointer"
									disabled={actionLoading !== null}
									onClick={() => handleAction("restart")}
								>
									Restart
								</DropdownMenuItem>
								<DropdownMenuItem
									className="cursor-pointer"
									disabled={actionLoading !== null}
									onClick={() => handleAction("start")}
								>
									Start
								</DropdownMenuItem>
								<DropdownMenuItem
									className="cursor-pointer"
									disabled={actionLoading !== null}
									onClick={() => handleAction("stop")}
								>
									Stop
								</DropdownMenuItem>
								<DropdownMenuItem
									className="cursor-pointer text-red-500 focus:text-red-600"
									disabled={actionLoading !== null}
									onClick={() => handleAction("kill")}
								>
									Kill
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
						<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-7xl">
							<DialogHeader>
								<DialogTitle>View logs</DialogTitle>
								<DialogDescription>Logs for {container.name}</DialogDescription>
							</DialogHeader>
							<div className="flex flex-col gap-4 pt-2.5">
								<DockerLogsId
									containerId={container.containerId}
									serverId={serverId}
									runType="native"
									serviceId={serviceId}
								/>
							</div>
						</DialogContent>
					</Dialog>
				)}
			</TableCell>
		</TableRow>
	);
};
