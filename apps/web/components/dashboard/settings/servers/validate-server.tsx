"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useQuery } from "convex/react";
import { Loader2, RefreshCw } from "lucide-react";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/ui-kit/primitives";
import { StatusRow } from "./gpu-support";
import { useHostSnapshot } from "./host-jobs";

type ValidationResult = {
	docker: { version: string; enabled: boolean };
	rclone: { version: string; enabled: boolean };
	nixpacks: { version: string; enabled: boolean };
	railpack: { version: string; enabled: boolean };
	buildpacks: { version: string; enabled: boolean };
	traefik: { version: string; enabled: boolean };
	isSwarmInstalled: boolean;
	isPanaraCloudNetworkInstalled: boolean;
	isMainDirectoryInstalled: boolean;
	privilegeMode: "root" | "sudo" | "none";
	dockerGroupMember: boolean;
};

interface Props {
	serverId: string;
}

export const ValidateServer = ({ serverId }: Props) => {
	const {
		data,
		refresh,
		error,
		isLoading: isPending,
		isRefreshing,
	} = useHostSnapshot<ValidationResult>(serverId, "validate", {
		enabled: !!serverId,
	});
	const isError = !!error;
	const server = useQuery(
		api.servers.get,
		serverId ? { serverId: serverId as Id<"servers"> } : "skip",
	);
	const isBuildServer = server?.serverType === "build";
	return (
		<div className="flex flex-col gap-4">
			<SectionHeader
				title="Setup check"
				description={
					isBuildServer
						? "Whether this build server has what builds need."
						: "Whether this server has what deployments need."
				}
			>
				<Button
					variant="outline"
					isLoading={isRefreshing}
					onClick={async () => {
						await refresh();
					}}
				>
					<RefreshCw data-icon="inline-start" />
					Check again
				</Button>
			</SectionHeader>
			{isError && <AlertBlock type="error">{error}</AlertBlock>}
			<div className="flex flex-col gap-4">
				{isPending ? (
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<Loader2 className="size-4 animate-spin" />
						<span>Checking the server…</span>
					</div>
				) : (
					<div className="grid w-full gap-4">
						<div>
							<div className="grid divide-y divide-border/70 border-y border-border/70">
								<StatusRow
									label="Docker Installed"
									isEnabled={data?.docker?.enabled}
									description={
										data?.docker?.enabled
											? `Installed: ${data?.docker?.version}`
											: undefined
									}
								/>
								{!isBuildServer && (
									<StatusRow
										label="RClone Installed"
										isEnabled={data?.rclone?.enabled}
										description={
											data?.rclone?.enabled
												? `Installed: ${data?.rclone?.version}`
												: undefined
										}
									/>
								)}
								<StatusRow
									label="Nixpacks Installed"
									isEnabled={data?.nixpacks?.enabled}
									description={
										data?.nixpacks?.enabled
											? `Installed: ${data?.nixpacks?.version}`
											: undefined
									}
								/>
								<StatusRow
									label="Buildpacks Installed"
									isEnabled={data?.buildpacks?.enabled}
									description={
										data?.buildpacks?.enabled
											? `Installed: ${data?.buildpacks?.version}`
											: undefined
									}
								/>
								<StatusRow
									label="Railpack Installed"
									isEnabled={data?.railpack?.enabled}
									description={
										data?.railpack?.enabled
											? `Installed: ${data?.railpack?.version}`
											: undefined
									}
								/>
								{!isBuildServer && (
									<>
										<StatusRow
											label="Docker Swarm Initialized"
											isEnabled={data?.isSwarmInstalled}
											description={
												data?.isSwarmInstalled
													? "Initialized"
													: "Not Initialized"
											}
										/>
										<StatusRow
											label="Panara Cloud Network Created"
											isEnabled={data?.isPanaraCloudNetworkInstalled}
											description={
												data?.isPanaraCloudNetworkInstalled
													? "Created"
													: "Not Created"
											}
										/>
										<StatusRow
											label="Traefik Installed"
											isEnabled={data?.traefik?.enabled}
											description={
												data?.traefik?.enabled
													? `Installed: ${data?.traefik?.version}`
													: undefined
											}
										/>
									</>
								)}
								<StatusRow
									label="Main Directory Created"
									isEnabled={data?.isMainDirectoryInstalled}
									description={
										data?.isMainDirectoryInstalled ? "Created" : "Not Created"
									}
								/>
								<StatusRow
									label="Privilege Mode"
									isEnabled={
										data?.privilegeMode === "root" ||
										data?.privilegeMode === "sudo"
									}
									description={
										data?.privilegeMode === "root"
											? "Running as root"
											: data?.privilegeMode === "sudo"
												? "Running with sudo"
												: "No sudo access (required for non-root)"
									}
								/>
								<StatusRow
									label="Docker Group"
									isEnabled={data?.dockerGroupMember}
									description={
										data?.dockerGroupMember
											? "User is in docker group"
											: "User is not in docker group"
									}
								/>
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
};
