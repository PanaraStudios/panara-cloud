"use client";

import { Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import type React from "react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { rendersNativeButton } from "@/lib/native-button";
import { badgeStateColor } from "../../application/logs/show";
import { useAppContainers } from "./host-containers";

export const DockerLogsId = dynamic(
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
	children?: React.ReactNode;
	serverId?: string;
	type?: "standalone" | "swarm";
	/** Render the picker and log viewer on the page instead of a dialog. */
	inline?: boolean;
}

export const ShowModalLogs = ({
	appName,
	children,
	serverId,
	type = "swarm",
	inline = false,
}: Props) => {
	const [dialogOpen, setIsOpen] = useState(false);
	const isOpen = inline || dialogOpen;
	const containers = useAppContainers({
		serverId,
		appName,
		appType: type,
		enabled: isOpen,
	});
	const isPending = containers.isLoading;
	const data = containers.data;
	const [containerId, setContainerId] = useState<string | undefined>();

	useEffect(() => {
		if (data && data?.length > 0) {
			setContainerId(data[0]?.containerId);
		}
	}, [data]);
	const body = (
		<div className="flex flex-col gap-4 pt-2.5">
			<Label>Select a container to view logs</Label>
			<Select onValueChange={setContainerId} value={containerId}>
				<SelectTrigger className="w-full">
					{isPending ? (
						<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground">
							<span>Loading...</span>
							<Loader2 className="animate-spin size-4" />
						</div>
					) : (
						<SelectValue placeholder="Select a container" />
					)}
				</SelectTrigger>
				<SelectContent>
					<SelectGroup>
						{data?.map((container) => (
							<SelectItem
								key={container.containerId}
								value={container.containerId}
							>
								{container.name} ({container.containerId}){" "}
								<Badge variant={badgeStateColor(container.state)}>
									{container.state}
								</Badge>
							</SelectItem>
						))}
						<SelectLabel>Containers ({data?.length})</SelectLabel>
					</SelectGroup>
				</SelectContent>
			</Select>
			<DockerLogsId
				containerId={containerId || ""}
				serverId={serverId}
				runType="native"
			/>
		</div>
	);

	if (inline) return body;

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger
				render={children as React.ReactElement}
				nativeButton={rendersNativeButton(children)}
			/>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg max-h-[85vh]  sm:max-w-7xl">
				<DialogHeader>
					<DialogTitle>View logs</DialogTitle>
					<DialogDescription>View the logs for {appName}</DialogDescription>
				</DialogHeader>
				{body}
			</DialogContent>
		</Dialog>
	);
};
