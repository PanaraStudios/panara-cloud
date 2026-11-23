"use client";

import { useEffect, useState } from "react";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import dynamic from "@/lib/router/dynamic";
import { cn } from "@/lib/utils";
import { useAppContainers } from "./host-containers";

const DockerLogsId = dynamic(
	() =>
		import("@/components/dashboard/docker/logs/docker-logs-id").then(
			(e) => e.DockerLogsId,
		),
	{ ssr: false },
);

const BAD = new Set(["restarting", "exited", "dead"]);

/** The logs of an app's containers on the page: the log viewer with a
    container picker in its toolbar. */
export function AppLogs({
	appName,
	serverId,
	type = "swarm",
	className,
}: {
	appName: string;
	serverId?: string;
	type?: "standalone" | "swarm";
	className?: string;
}) {
	const containers = useAppContainers({
		serverId,
		appName,
		appType: type,
		enabled: true,
	});
	const data = containers.data;
	const [containerId, setContainerId] = useState<string | undefined>();
	useEffect(() => {
		setContainerId(data?.[0]?.containerId);
	}, [data]);
	const current = data?.find((item) => item.containerId === containerId);
	return (
		<DockerLogsId
			containerId={containerId ?? "select-a-container"}
			serverId={serverId}
			runType="native"
			listClassName={className}
			toolbarStart={
				!data || data.length === 0 ? (
					<span className="flex h-8 items-center rounded-lg border border-border px-3 text-[13px] text-muted-foreground">
						{containers.isLoading ? "Loading containers…" : "No containers"}
					</span>
				) : (
					<Select
						value={containerId ?? ""}
						onValueChange={(value) => setContainerId(value ?? undefined)}
					>
						<SelectTrigger
							size="sm"
							aria-label="Container"
							className="h-8 max-w-64 gap-1.5"
						>
							<span className="flex min-w-0 items-center gap-1.5">
								<span className="text-muted-foreground">Container</span>
								<span className="truncate font-mono text-[13px]">
									{current?.name ?? <SelectValue placeholder="none" />}
								</span>
							</span>
						</SelectTrigger>
						<SelectContent align="start" className="min-w-64">
							<SelectGroup>
								<SelectLabel>Containers ({data.length})</SelectLabel>
								{data.map((container) => (
									<SelectItem
										key={container.containerId}
										value={container.containerId}
									>
										<span
											className={cn(
												"size-1.5 shrink-0 rounded-full",
												BAD.has(container.state)
													? "bg-destructive"
													: "bg-success",
											)}
										/>
										<span className="font-mono text-[13px]">
											{container.name}
										</span>
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				)
			}
		/>
	);
}
