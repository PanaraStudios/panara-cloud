"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { badgeStateColor } from "@/components/dashboard/application/logs/show";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
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
import { errorMessage } from "@/lib/auth/errors";
import {
	useRestartContainer,
	useServiceContainers,
} from "../../use-service-containers";
import { ContainerPaidMonitoring } from "./show-paid-container-monitoring";

interface Props {
	appName: string;
	serverId?: string;
	appType: "stack" | "docker-compose";
	baseUrl?: string;
	token?: string;
	serviceId?: string;
}

export const ComposePaidMonitoring = ({ serverId, serviceId }: Props) => {
	const { data, isPending } = useServiceContainers("compose", serviceId);

	const [containerAppName, setContainerAppName] = useState<string | undefined>(
		"",
	);

	const [containerId, setContainerId] = useState<string | undefined>();

	const { mutateAsync: restart, isPending: isRestarting } =
		useRestartContainer();

	useEffect(() => {
		if (data && data?.length > 0) {
			setContainerAppName(data[0]?.name);
			setContainerId(data[0]?.containerId);
		}
	}, [data]);

	return (
		<div>
			<Card className="bg-background border-0">
				<CardHeader>
					<CardTitle className="text-xl">Monitoring</CardTitle>
					<CardDescription>Watch the usage of your compose</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<Label>Select a container to watch the monitoring</Label>
					<div className="flex flex-row gap-4">
						<Select
							onValueChange={(value) => {
								setContainerAppName(value);
								setContainerId(
									data?.find((container) => container.name === value)
										?.containerId,
								);
							}}
							value={containerAppName}
						>
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
											value={container.name}
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
						<Button
							isLoading={isRestarting}
							onClick={async () => {
								if (!containerId) return;
								toast.success(`Restarting container ${containerAppName}`);
								await restart({ containerId, serverId })
									.then(() => {
										toast.success("Container restarted");
									})
									.catch((error) => toast.error(errorMessage(error)));
							}}
						>
							Restart
						</Button>
					</div>
					<div className="flex flex-col gap-4">
						<ContainerPaidMonitoring
							appName={containerAppName || ""}
							serviceId={serviceId}
							serviceKind="compose"
						/>
					</div>
				</CardContent>
			</Card>
		</div>
	);
};
