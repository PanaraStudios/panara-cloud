"use client";

import dynamic from "next/dynamic";
import type React from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
export const DockerLogsId = dynamic(
	() => import("./docker-logs-id").then((e) => e.DockerLogsId),
	{
		ssr: false,
	},
);

interface Props {
	containerId: string;
	children?: React.ReactNode;
	serverId?: string | null;
}

export const ShowDockerModalStackLogs = ({
	containerId,
	children,
	serverId,
}: Props) => {
	return (
		<Dialog>
			<DialogTrigger
				role="menuitem"
				render={
					<DropdownMenuItem
						className="w-full cursor-pointer space-x-3"
						closeOnClick={false}
					/>
				}
				nativeButton={false}
			>
				{children}
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-7xl">
				<DialogHeader>
					<DialogTitle>View Logs</DialogTitle>
					<DialogDescription>View the logs for {containerId}</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4 pt-2.5">
					<DockerLogsId
						containerId={containerId || ""}
						serverId={serverId}
						runType="swarm"
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
};
