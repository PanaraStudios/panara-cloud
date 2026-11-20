"use client";

import { Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import {
	useServiceContainers,
	useServiceTasks,
} from "@/components/dashboard/docker/logs/use-service-containers";
import { resolveContainerSelection } from "@/components/dashboard/docker/logs/utils";
import { Badge } from "@/components/ui/badge";
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
import { Switch } from "@/components/ui/switch";
export const DockerLogs = dynamic(
	() =>
		import("@/components/dashboard/docker/logs/docker-logs-id").then(
			(e) => e.DockerLogsId,
		),
	{
		ssr: false,
	},
);

export const badgeStateColor = (state: string) => {
	switch (state) {
		case "running":
		case "ready":
			return "success";
		case "exited":
		case "shutdown":
			return "destructive";
		case "accepted":
		case "created":
			return "info";
		default:
			return "default";
	}
};

interface Props {
	appName: string;
	serverId?: string;
	serviceId?: string;
}

export const ShowDockerLogs = ({ appName, serverId, serviceId }: Props) => {
	const [containerId, setContainerId] = useState<string | undefined>();
	const [option, setOption] = useState<"swarm" | "native">("native");

	const {
		containers,
		isLoading: containersLoading,
		error: nativeError,
	} = useServiceContainers(
		appName,
		serverId || undefined,
		!!appName && option === "native",
	);

	const {
		tasks: services,
		isLoading: servicesLoading,
		error: swarmError,
	} = useServiceTasks(
		appName,
		serverId || undefined,
		!!appName && option === "swarm",
	);
	const containersError = option === "native" ? nativeError : swarmError;

	const availableContainers = option === "native" ? containers : services;

	useEffect(() => {
		setContainerId((currentContainerId) =>
			resolveContainerSelection(currentContainerId, availableContainers),
		);
	}, [availableContainers]);

	const isLoading = option === "native" ? containersLoading : servicesLoading;
	const containersLength =
		option === "native" ? containers?.length : services?.length;

	return (
		<section className="flex min-w-0 flex-col gap-4">
			<div className="flex flex-row flex-wrap items-start justify-between gap-3">
				<h2 className="font-semibold text-[15px]">Logs</h2>
				<p className="text-muted-foreground text-sm">
					Watch the logs of the application in real time
				</p>
			</div>

			<div className="flex flex-col gap-4">
				<div className="flex flex-col sm:flex-row justify-between sm:items-center gap-2">
					<Label>Select a container to view logs</Label>
					<div className="flex flex-row gap-2 items-center">
						<span className="text-sm text-muted-foreground">
							{option === "native" ? "Native" : "Swarm"}
						</span>
						<Switch
							checked={option === "native"}
							onCheckedChange={(checked) => {
								setContainerId(undefined);
								setOption(checked ? "native" : "swarm");
							}}
						/>
					</div>
				</div>

				<Select onValueChange={setContainerId} value={containerId}>
					<SelectTrigger className="w-full">
						{isLoading ? (
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
							{option === "native" ? (
								<div>
									{containers?.map((container) => (
										<SelectItem
											key={container.containerId}
											value={container.containerId}
										>
											{container.name} ({container.containerId}){" "}
											<Badge variant={badgeStateColor(container.state)}>
												{container.state}
											</Badge>
											{container.status ? ` ${container.status}` : ""}
										</SelectItem>
									))}
								</div>
							) : (
								<>
									{services?.map((container) => (
										<SelectItem
											key={container.containerId}
											value={container.containerId}
										>
											{container.name} ({container.containerId}@{container.node}
											)
											<Badge variant={badgeStateColor(container.state)}>
												{container.state}
											</Badge>
											{container.currentState
												? ` ${container.currentState}`
												: ""}
										</SelectItem>
									))}
								</>
							)}

							<SelectLabel>Containers ({containersLength})</SelectLabel>
						</SelectGroup>
					</SelectContent>
				</Select>
				{containersError && (
					<div className="text-sm">
						<p>Couldn't load the containers.</p>
						<p className="mt-1 break-words font-mono text-[13px] text-muted-foreground">
							{containersError}
						</p>
					</div>
				)}
				{option === "swarm" &&
					services?.find((c) => c.containerId === containerId)?.error && (
						<div className="text-sm">
							<p>Couldn't load the containers.</p>
							<p className="mt-1 break-words font-mono text-[13px] text-muted-foreground">
								{services?.find((c) => c.containerId === containerId)?.error}
							</p>
						</div>
					)}
				<DockerLogs
					serverId={serverId || ""}
					containerId={containerId || "select-a-container"}
					runType={option}
					serviceId={serviceId}
				/>
			</div>
		</section>
	);
};
