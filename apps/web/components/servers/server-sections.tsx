"use client";

import { ActivityIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useAppContainers } from "@/components/dashboard/settings/web-server/host-containers";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
} from "@/components/ui/select";
import { EmptyState, PageHeader } from "@/components/ui-kit/primitives";
import { type Permissions, usePermissions } from "@/lib/permissions";
import { containerStatus } from "./containers-data";
import { StatusText } from "./server-ui";
import { useServerRef } from "./use-server";

const DockerLogsId = dynamic(
	() =>
		import("@/components/dashboard/docker/logs/docker-logs-id").then(
			(module) => module.DockerLogsId,
		),
	{ ssr: false },
);

function Allowed({
	when,
	children,
}: {
	when: (permissions: Permissions) => boolean;
	children: React.ReactNode;
}) {
	const permissions = usePermissions();
	if (!when(permissions))
		return (
			<EmptyState
				icon={ActivityIcon}
				title="Not available"
				description="Your role doesn't include this part of the server."
			/>
		);
	return children;
}

const APP_LOG_TITLES: Record<string, string> = {
	"panara-cloud": "Panel logs",
	"panara-cloud-traefik": "Traefik logs",
};

function AppLogs({ app }: { app: string }) {
	const ref = useServerRef();
	const containers = useAppContainers({
		serverId: ref.serverId,
		appName: app,
		appType: "standalone",
		enabled: true,
	});
	const [containerId, setContainerId] = useState<string | undefined>();
	useEffect(() => {
		const first = containers.data?.[0];
		if (first) setContainerId(first.containerId);
	}, [containers.data]);
	const selected = containers.data?.find(
		(container) => container.containerId === containerId,
	);
	return (
		<DockerLogsId
			containerId={containerId || "select-a-container"}
			serverId={ref.serverId}
			runType="native"
			urlState
			listClassName="h-[calc(100svh-24.5rem)] min-h-96"
			toolbarStart={
				<Select
					value={containerId ?? ""}
					onValueChange={(value) => setContainerId(String(value))}
				>
					<SelectTrigger
						size="sm"
						aria-label="Container"
						className="h-8 max-w-72 gap-1.5"
					>
						<span className="text-muted-foreground">Container</span>
						<span className="truncate font-mono text-[13px]">
							{containers.isLoading
								? "Loading…"
								: (selected?.name ?? "none running")}
						</span>
					</SelectTrigger>
					<SelectContent align="start" className="min-w-72">
						{containers.data?.length ? (
							containers.data.map((container) => {
								const status = containerStatus(container);
								return (
									<SelectItem
										key={container.containerId}
										value={container.containerId}
									>
										<span className="truncate font-mono text-[13px]">
											{container.name}
										</span>
										<StatusText
											tone={status.tone}
											label={status.label}
											className="text-muted-foreground"
										/>
									</SelectItem>
								);
							})
						) : (
							<p className="px-2 py-1.5 text-muted-foreground text-sm">
								{containers.isLoading
									? "Loading…"
									: "No running container for this app."}
							</p>
						)}
					</SelectContent>
				</Select>
			}
		/>
	);
}

// Logs of a host-level container (the panel, Traefik) picked by app name.
export function ServerAppLogsPage() {
	const app = useSearchParams().get("app") ?? "panara-cloud-traefik";
	return (
		<Allowed when={(p) => p.docker.read}>
			<div className="flex w-full flex-col gap-4 pb-6">
				<PageHeader
					title={APP_LOG_TITLES[app] ?? "Logs"}
					description={<span className="font-mono text-[13px]">{app}</span>}
				/>
				<AppLogs key={app} app={app} />
			</div>
		</Allowed>
	);
}
