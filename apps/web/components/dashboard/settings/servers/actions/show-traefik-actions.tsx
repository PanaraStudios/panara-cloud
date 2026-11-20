"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { errorMessage } from "@/lib/auth/errors";
import { EditTraefikEnv } from "../../web-server/edit-traefik-env";
import { ManageTraefikPorts } from "../../web-server/manage-traefik-ports";
import { UpdateTraefikVersion } from "../../web-server/update-traefik-version";
import { hostId, useWaitForJob } from "../host-jobs";

interface Props {
	serverId?: string;
}
export const ShowTraefikActions = ({ serverId }: Props) => {
	const reloadTraefik = useMutation(api.infra.webServer.reloadTraefik);
	const toggleDashboard = useMutation(api.infra.webServer.setDashboard);
	const traefikSettings = useQuery(api.infra.webServer.getTraefikSettings, {
		serverId: hostId(serverId),
	});
	const haveTraefikDashboardPortEnabled = traefikSettings?.dashboardEnabled;
	const waitForJob = useWaitForJob();

	const [reloadTraefikIsLoading, setReloadTraefikIsLoading] = useState(false);
	const [toggleDashboardIsLoading, setToggleDashboardIsLoading] =
		useState(false);
	const [isHealthCheckExecuting, setIsHealthCheckExecuting] = useState(false);
	const [isReloadHealthCheckExecuting, setIsReloadHealthCheckExecuting] =
		useState(false);

	const executeWithJob = async (
		start: () => Promise<Id<"jobs">>,
		setStarting: (value: boolean) => void,
		setWaiting: (value: boolean) => void,
		successMessage: string,
	) => {
		setStarting(true);
		let jobId: Id<"jobs">;
		try {
			jobId = await start();
		} finally {
			setStarting(false);
		}
		setWaiting(true);
		try {
			await waitForJob(jobId);
			toast.success(successMessage);
		} finally {
			setWaiting(false);
		}
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				disabled={
					reloadTraefikIsLoading ||
					toggleDashboardIsLoading ||
					isHealthCheckExecuting ||
					isReloadHealthCheckExecuting
				}
				render={
					<Button
						isLoading={
							reloadTraefikIsLoading ||
							toggleDashboardIsLoading ||
							isHealthCheckExecuting ||
							isReloadHealthCheckExecuting
						}
						variant="outline"
					/>
				}
			>
				Traefik
			</DropdownMenuTrigger>
			<DropdownMenuContent className="w-56" align="start">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Actions</DropdownMenuLabel>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem
						onClick={async () => {
							try {
								await executeWithJob(
									() => reloadTraefik({ serverId: hostId(serverId) }),
									setReloadTraefikIsLoading,
									setIsReloadHealthCheckExecuting,
									"Traefik Reloaded",
								);
							} catch (error) {
								toast.error(
									errorMessage(error) ||
										"Failed to reload Traefik. Please try again.",
								);
							}
						}}
						className="cursor-pointer"
						disabled={isReloadHealthCheckExecuting}
					>
						<span>Reload</span>
					</DropdownMenuItem>
					<DropdownMenuItem
						nativeButton={false}
						render={
							<Link
								href={`/servers/${serverId || "local"}/logs?app=panara-cloud-traefik`}
							/>
						}
					>
						View logs
					</DropdownMenuItem>
					<EditTraefikEnv serverId={serverId}>
						<DropdownMenuItem closeOnClick={false} className="cursor-pointer">
							<span>Modify Environment</span>
						</DropdownMenuItem>
					</EditTraefikEnv>

					<DialogAction
						title={
							haveTraefikDashboardPortEnabled
								? "Disable Traefik Dashboard"
								: "Enable Traefik Dashboard"
						}
						description={
							<div className="space-y-4">
								<AlertBlock type="warning">
									The Traefik container will be recreated from scratch. This
									means the container will be deleted and created again, which
									may cause downtime in your applications.
								</AlertBlock>
								<p>
									Are you sure you want to{" "}
									{haveTraefikDashboardPortEnabled ? "disable" : "enable"} the
									Traefik dashboard?
								</p>
							</div>
						}
						onClick={async () => {
							try {
								await executeWithJob(
									() =>
										toggleDashboard({
											enabled: !haveTraefikDashboardPortEnabled,
											serverId: hostId(serverId),
										}),
									setToggleDashboardIsLoading,
									setIsHealthCheckExecuting,
									"Traefik dashboard updated successfully",
								);
							} catch (error) {
								toast.error(
									errorMessage(error) ||
										"Failed to toggle dashboard. Please check if port 8080 is available.",
								);
							}
						}}
						disabled={toggleDashboardIsLoading || isHealthCheckExecuting}
						type="default"
					>
						<DropdownMenuItem
							closeOnClick={false}
							className="w-full cursor-pointer space-x-3"
						>
							<span>
								{haveTraefikDashboardPortEnabled ? "Disable" : "Enable"}{" "}
								Dashboard
							</span>
						</DropdownMenuItem>
					</DialogAction>
					<ManageTraefikPorts serverId={serverId}>
						<DropdownMenuItem closeOnClick={false} className="cursor-pointer">
							<span>Additional Port Mappings</span>
						</DropdownMenuItem>
					</ManageTraefikPorts>
					<UpdateTraefikVersion serverId={serverId}>
						<DropdownMenuItem closeOnClick={false} className="cursor-pointer">
							<span>Check Version</span>
						</DropdownMenuItem>
					</UpdateTraefikVersion>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
};
