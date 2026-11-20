"use client";

import { Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
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
	appType: "stack" | "docker-compose";
	serviceId?: string;
}

export const ShowDockerLogsCompose = ({
	appName,
	appType: _appType,
	serverId,
	serviceId,
}: Props) => {
	const { data, isPending } = useComposeContainers(serviceId, {
		enabled: !!appName,
		poll: true,
	});
	const [containerId, setContainerId] = useState<string | undefined>();

	useEffect(() => {
		setContainerId((currentContainerId) =>
			resolveContainerSelection(currentContainerId, data),
		);
	}, [data]);

	return (
		<section className="flex min-w-0 flex-col gap-4">
			<div className="flex flex-row flex-wrap items-start justify-between gap-3">
				<h2 className="font-semibold text-[15px]">Logs</h2>
				<p className="text-muted-foreground text-sm">
					Watch the logs of the application in real time
				</p>
			</div>

			<div className="flex flex-col gap-4">
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
									{container.status ? ` ${container.status}` : ""}
								</SelectItem>
							))}
							<SelectLabel>Containers ({data?.length})</SelectLabel>
						</SelectGroup>
					</SelectContent>
				</Select>
				<DockerLogs
					serverId={serverId || ""}
					containerId={containerId || "select-a-container"}
					runType="native"
					serviceId={serviceId}
				/>
			</div>
		</section>
	);
};
