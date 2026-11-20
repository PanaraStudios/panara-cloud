"use client";

import { Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { badgeStateColor } from "@/components/dashboard/application/logs/show";
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
import { useComposeContainers } from "../use-compose";
export const DockerLogs = dynamic(
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
	serviceId?: string;
}

export const ShowDockerLogsStack = ({
	appName,
	serverId,
	serviceId,
}: Props) => {
	const [option, setOption] = useState<"swarm" | "native">("native");
	const [containerId, setContainerId] = useState<string | undefined>();

	const { data, isPending } = useComposeContainers(serviceId, {
		enabled: !!appName,
		poll: true,
	});
	const containersLoading = isPending;
	const servicesLoading = isPending;
	// Swarm logs are read per service (`docker service logs`); tasks on other
	// nodes are not listed in the host snapshot.
	const services = useMemo(() => {
		const names = [
			...new Set(
				(data ?? []).flatMap((container) =>
					container.service ? [container.service] : [],
				),
			),
		];
		return names.map((name) => {
			const replicas = (data ?? []).filter((c) => c.service === name);
			return {
				containerId: name,
				name,
				node: "",
				state: replicas.some((c) => c.state === "running")
					? "running"
					: (replicas[0]?.state ?? "unknown"),
				currentState: replicas[0]?.status ?? "",
				error: undefined as string | undefined,
			};
		});
	}, [data]);

	const containers = data?.filter((container) => container.containerId);
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
				<div className="flex flex-row justify-between items-center gap-2">
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
				{option === "swarm" &&
					services?.find((c) => c.containerId === containerId)?.error && (
						<div className="text-sm">
							<p>Couldn't load the containers.</p>
							<p className="mt-1 break-words font-mono text-[13px] text-muted-foreground">
								{services.find((c) => c.containerId === containerId)?.error}
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
