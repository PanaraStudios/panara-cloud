"use client";

import { Layers, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useSwarmServices } from "../use-swarm-data";
import { type ApplicationList, columns } from "./columns";
import { DataTable } from "./data-table";

interface Props {
	serverId?: string;
}

export const ShowNodeApplications = ({ serverId }: Props) => {
	const {
		services: NodeApps,
		tasks: NodeAppDetails,
		isLoading: NodeAppsLoading,
	} = useSwarmServices(serverId);
	const NodeAppDetailsLoading = NodeAppsLoading;

	if (NodeAppsLoading || NodeAppDetailsLoading) {
		return (
			<Dialog>
				<DialogTrigger render={<Button variant="outline" size="sm" />}>
					<Loader2 className="h-4 w-4 mr-2 animate-spin" />
				</DialogTrigger>
			</Dialog>
		);
	}

	if (!NodeApps || !NodeAppDetails) {
		return (
			<span className="text-sm w-full flex text-center justify-center items-center">
				No data found
			</span>
		);
	}

	const combinedData: ApplicationList[] = NodeApps.flatMap((app) => {
		const appDetails =
			NodeAppDetails?.filter((detail) =>
				detail.Name.startsWith(`${app.Name}.`),
			) || [];

		if (appDetails.length === 0) {
			return [
				{
					...app,
					CurrentState: "N/A",
					DesiredState: "N/A",
					Error: "",
					Node: "N/A",
					Ports: app.Ports,
					serverId: serverId || "",
				},
			];
		}

		return appDetails.map((detail) => ({
			...app,
			CurrentState: detail.CurrentState,
			DesiredState: detail.DesiredState,
			Error: detail.Error,
			Node: detail.Node,
			Ports: detail.Ports || app.Ports,
			serverId: serverId || "",
		}));
	});

	return (
		<Dialog>
			<DialogTrigger render={<Button variant="outline" size="sm" />}>
				<Layers className="h-4 w-4 mr-2" />
				Services
			</DialogTrigger>
			<DialogContent
				className={cn(
					"flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg",
					"sm:max-w-10xl",
				)}
			>
				<DialogHeader>
					<DialogTitle>Node Applications</DialogTitle>
					<DialogDescription>
						See in detail the applications running on this node
					</DialogDescription>
				</DialogHeader>
				<div className="max-h-[80vh]">
					<DataTable columns={columns} data={combinedData ?? []} />
				</div>
			</DialogContent>
		</Dialog>
	);
};
