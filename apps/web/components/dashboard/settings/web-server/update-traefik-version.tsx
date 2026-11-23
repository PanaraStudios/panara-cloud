"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import {
	AlertCircle,
	AlertTriangle,
	CheckCircle2,
	Info,
	Loader2,
	RefreshCcw,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { errorMessage } from "@/lib/auth/errors";
import { rendersNativeButton } from "@/lib/native-button";
import { hostId, useHostSnapshot, useWaitForJob } from "../servers/host-jobs";

type TraefikState = {
	exists: boolean;
	state: string | null;
	image: string | null;
	version: string | null;
	recommendedVersion: string;
	versionStatus: "current" | "outdated" | "newer" | "unknown" | "custom";
};

// The version statuses the overview shows.
type TraefikOverviewStatus =
	| "up-to-date"
	| "outdated"
	| "newer"
	| "unknown"
	| "custom"
	| "not-found";

interface Props {
	children?: React.ReactNode;
	serverId?: string;
}

export const UpdateTraefikVersion = ({ children, serverId }: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const [isWaiting, setIsWaiting] = useState(false);
	const [lastUpdateError, setLastUpdateError] = useState<string | null>(null);

	const snapshot = useHostSnapshot<TraefikState>(serverId, "traefik", {
		enabled: isOpen,
	});
	const state = snapshot.data;
	const versionStatus: TraefikOverviewStatus | undefined = !state
		? undefined
		: !state.exists
			? "not-found"
			: state.versionStatus === "current"
				? "up-to-date"
				: state.versionStatus;
	const data = state
		? {
				...state,
				currentVersion: state.version,
				versionStatus: versionStatus as TraefikOverviewStatus,
				isUpdating: isWaiting,
				lastUpdateError,
			}
		: undefined;
	const isError = !!snapshot.error && !state;
	const error = isError ? { message: snapshot.error } : null;
	const isPending = snapshot.isLoading;
	const isFetching = snapshot.isRefreshing;
	const refetch = () => snapshot.refresh().catch(() => {});

	const updateTraefik = useMutation(api.infra.webServer.applyTraefik);
	const waitForJob = useWaitForJob();
	const [isUpdating, setIsUpdating] = useState(false);

	const isInProgress = isUpdating || isWaiting;

	const handleUpdate = async () => {
		try {
			setIsUpdating(true);
			const jobId = await updateTraefik({
				serverId: hostId(serverId),
			}).finally(() => setIsUpdating(false));
			setIsWaiting(true);
			setLastUpdateError(null);
			await waitForJob(jobId);
			toast.success("Traefik updated");
		} catch (error) {
			const message = errorMessage(error);
			setLastUpdateError(message);
			toast.error(
				message
					? `Traefik update failed: ${message}`
					: "Failed to update Traefik. Please try again.",
			);
		} finally {
			setIsWaiting(false);
			refetch();
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger
				render={children as React.ReactElement}
				nativeButton={rendersNativeButton(children)}
			/>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Traefik update</DialogTitle>
					<DialogDescription>
						Compare the running Traefik with the version recommended by this
						Panara Cloud release.
					</DialogDescription>
				</DialogHeader>

				{isError && !isInProgress && (
					<AlertBlock type="error" icon={<AlertTriangle className="size-4" />}>
						{error?.message}
					</AlertBlock>
				)}

				{isPending && !isError ? (
					<div className="flex items-center justify-center text-muted-foreground py-4">
						<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						<span>Checking Traefik version</span>
					</div>
				) : (
					data &&
					(!isError || isInProgress) && (
						<div className="space-y-4">
							{data.versionStatus !== "not-found" && (
								<div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-lg border p-4 text-sm">
									<span className="text-muted-foreground">
										Installed version
									</span>
									<span className="justify-self-end text-right font-medium break-all">
										{data.currentVersion && data.versionStatus !== "custom"
											? `v${data.currentVersion}`
											: data.image}
									</span>
									<span className="text-muted-foreground">
										Recommended version
									</span>
									<span className="justify-self-end font-medium">
										v{data.recommendedVersion}
									</span>
								</div>
							)}

							{data.lastUpdateError && !isInProgress && (
								<AlertBlock
									type="error"
									icon={<AlertTriangle className="size-4" />}
								>
									Last update failed: {data.lastUpdateError}
								</AlertBlock>
							)}
							{data.versionStatus !== "not-found" &&
								data.state !== "running" && (
									<AlertBlock
										type="error"
										icon={<AlertTriangle className="size-4" />}
									>
										{data.state === "restarting"
											? "Traefik keeps restarting, so your applications are unreachable. Check View Logs for the error."
											: `Traefik is not running (${data.state ?? "unknown"}), so your applications are unreachable. Use Reload to start it${data.versionStatus === "outdated" ? ", then update it" : ""}.`}
									</AlertBlock>
								)}
							{data.versionStatus === "outdated" && (
								<AlertBlock
									type="warning"
									icon={<AlertCircle className="size-4" />}
								>
									Panara Cloud recommends Traefik v{data.recommendedVersion}.
									Updating is optional and recreates the Traefik container, so
									your applications may be unreachable for a few seconds. Env
									variables and port mappings are kept.
								</AlertBlock>
							)}
							{data.versionStatus === "up-to-date" &&
								data.state === "running" && (
									<AlertBlock
										type="success"
										icon={<CheckCircle2 className="size-4" />}
									>
										Traefik is on the version recommended by Panara Cloud.
									</AlertBlock>
								)}
							{data.versionStatus === "newer" && (
								<AlertBlock type="info" icon={<Info className="size-4" />}>
									Traefik is newer than the version recommended by Panara Cloud.
									No update needed.
								</AlertBlock>
							)}
							{data.versionStatus === "custom" && (
								<AlertBlock type="info" icon={<Info className="size-4" />}>
									Traefik runs a custom image, so Panara Cloud won't update it.
									Saving Traefik env or port mappings replaces it with the
									official image.
								</AlertBlock>
							)}
							{data.versionStatus === "unknown" && (
								<AlertBlock
									type="warning"
									icon={<AlertCircle className="size-4" />}
								>
									Couldn't read a version from the Traefik image{" "}
									<span className="font-mono">{data.image}</span>.
								</AlertBlock>
							)}
							{data.versionStatus === "not-found" && (
								<AlertBlock
									type="error"
									icon={<AlertTriangle className="size-4" />}
								>
									The panara-cloud-traefik container was not found on this
									server.
								</AlertBlock>
							)}
						</div>
					)
				)}

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => refetch()}
						isLoading={isFetching && !isPending && !isInProgress}
						disabled={isInProgress}
					>
						<RefreshCcw className="h-4 w-4" />
						Check again
					</Button>
					<Button
						onClick={handleUpdate}
						isLoading={isInProgress}
						disabled={
							data?.versionStatus !== "outdated" ||
							data.state !== "running" ||
							isError ||
							isFetching
						}
					>
						{data?.versionStatus === "outdated"
							? `Update to v${data.recommendedVersion}`
							: "Update"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
