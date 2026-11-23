"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import {
	ChevronDownIcon,
	CircleArrowUpIcon,
	LayoutDashboardIcon,
	RotateCwIcon,
	ScrollTextIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import {
	hostId,
	useWaitForJob,
} from "@/components/dashboard/settings/servers/host-jobs";
import { UpdateTraefikVersion } from "@/components/dashboard/settings/web-server/update-traefik-version";
import { TraefikIcon } from "@/components/icons/server-icons";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog, EmptyState } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { useQueryResult, useSnapshot } from "@/lib/host-data";
import { serverUrl } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { LinkTabs, StatusText } from "./server-ui";
import { useServerRef } from "./use-server";

export type TraefikState = {
	exists: boolean;
	state: string | null;
	image: string | null;
	version: string | null;
	env?: string[];
};

/** Traefik's container state on this server; admins only (else null). */
export function useTraefikState(serverId: string | undefined) {
	return useSnapshot<TraefikState>(serverId, "traefik");
}

/** Traefik settings when the member may change them (null otherwise). */
export function useTraefikSettings(serverId: string | undefined) {
	const settings = useQueryResult(api.infra.webServer.getTraefikSettings, {
		serverId: hostId(serverId),
	});
	return settings instanceof Error ? null : settings;
}

function TraefikStatus({ serverId }: { serverId: string | undefined }) {
	const { data } = useTraefikState(serverId);
	if (!data) return null;
	if (!data.exists) {
		return <StatusText tone="destructive" label="Not running" />;
	}
	const running = data.state === "running";
	return (
		<StatusText
			tone={running ? "success" : "warning"}
			label={`${running ? "Running" : (data.state ?? "Unknown")}${data.version ? ` · v${data.version.replace(/^v/, "")}` : ""}`}
		/>
	);
}

function TraefikActions({ serverId }: { serverId: string | undefined }) {
	const ref = useServerRef();
	const settings = useTraefikSettings(serverId);
	const reload = useMutation(api.infra.webServer.reloadTraefik);
	const setDashboard = useMutation(api.infra.webServer.setDashboard);
	const waitForJob = useWaitForJob();
	const [reloading, setReloading] = useState(false);
	const [dashboardOpen, setDashboardOpen] = useState(false);
	if (!settings) return null;

	return (
		<div className="flex shrink-0 items-center gap-2">
			<Button
				variant="outline"
				isLoading={reloading}
				onClick={async () => {
					setReloading(true);
					try {
						await waitForJob(await reload({ serverId: hostId(serverId) }));
						toast.success("Traefik reloaded");
					} catch (error) {
						toast.error(errorMessage(error));
					} finally {
						setReloading(false);
					}
				}}
			>
				<RotateCwIcon data-icon="inline-start" />
				Reload
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger render={<Button variant="outline" />}>
					More
					<ChevronDownIcon className="size-3.5 text-muted-foreground" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-52">
					<DropdownMenuGroup>
						<DropdownMenuItem
							nativeButton={false}
							render={
								<Link
									href={`${serverUrl(ref.routeId, "logs")}?app=panara-cloud-traefik`}
								/>
							}
						>
							<ScrollTextIcon />
							Container logs
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => setDashboardOpen(true)}>
							<LayoutDashboardIcon />
							{settings.dashboardEnabled ? "Disable" : "Enable"} dashboard
						</DropdownMenuItem>
						<UpdateTraefikVersion serverId={serverId}>
							<DropdownMenuItem closeOnClick={false}>
								<CircleArrowUpIcon />
								Check version
							</DropdownMenuItem>
						</UpdateTraefikVersion>
					</DropdownMenuGroup>
				</DropdownMenuContent>
			</DropdownMenu>
			<ConfirmDialog
				open={dashboardOpen}
				onOpenChange={setDashboardOpen}
				title={`${settings.dashboardEnabled ? "Disable" : "Enable"} the Traefik dashboard?`}
				description="Traefik's container is recreated, so requests to your apps may fail for a few seconds."
				confirmLabel={settings.dashboardEnabled ? "Disable" : "Enable"}
				onConfirm={async () => {
					await waitForJob(
						await setDashboard({
							serverId: hostId(serverId),
							enabled: !settings.dashboardEnabled,
						}),
					);
					toast.success("Traefik dashboard updated");
				}}
			/>
		</div>
	);
}

/** Header, actions and section links shared by the Traefik pages. */
export function TraefikShell({ children }: { children: React.ReactNode }) {
	const ref = useServerRef();
	const permissions = usePermissions();
	if (!permissions.traefikFiles.read) {
		return (
			<EmptyState
				icon={TraefikIcon}
				title="Not available"
				description="Your role doesn't include this part of the server."
			/>
		);
	}
	const base = serverUrl(ref.routeId, "traefik");
	return (
		<div className="flex w-full flex-col gap-4 pb-6">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
				<LinkTabs
					items={[
						{ label: "Config files", href: base, exact: true },
						{ label: "Access log", href: `${base}/access-log` },
						{ label: "Ports & environment", href: `${base}/ports` },
					]}
				/>
				<div className="ml-auto flex flex-wrap items-center gap-3">
					<TraefikStatus serverId={ref.serverId} />
					<TraefikActions serverId={ref.serverId} />
				</div>
			</div>
			{children}
		</div>
	);
}
