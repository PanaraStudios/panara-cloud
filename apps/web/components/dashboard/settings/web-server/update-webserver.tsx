"use client";

import { api } from "@panara-cloud/backend/api";
import { useConvex, useMutation } from "convex/react";
import {
	CheckCircle2,
	HardDriveDownload,
	Loader2,
	RefreshCw,
	XCircle,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogClose,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/auth/errors";
import { cn } from "@/lib/utils";
import { waitForJob } from "../servers/host-jobs";
import type { PanelStatus } from "./panel-actions";
import { useRunPanelAction } from "./panel-actions";

type ServiceStatus = {
	status: "healthy" | "unhealthy";
	message?: string;
};

// The panel's state lives in Convex, so the health check covers the panel's
// own services and Traefik on the panel host.
type HealthResult = {
	services: { name: string; status: ServiceStatus }[];
	traefik: ServiceStatus;
};

type ModalState = "idle" | "checking" | "results" | "updating";

const ServiceStatusItem = ({
	name,
	service,
}: {
	name: string;
	service: ServiceStatus;
}) => (
	<div className="flex items-center gap-2">
		{service.status === "healthy" ? (
			<CheckCircle2 className="size-4 text-success" />
		) : (
			<XCircle className="size-4 text-destructive" />
		)}
		<span className="text-sm font-medium">{name}</span>
		{service.status === "unhealthy" && service.message && (
			<span className="text-xs text-muted-foreground">— {service.message}</span>
		)}
	</div>
);

export const UpdateWebServer = ({
	buttonClassName,
	label = "Update panel",
	disabledReason,
}: {
	buttonClassName?: string;
	/** "Retry update" after an update that failed. */
	label?: string;
	disabledReason?: string | null;
}) => {
	const [modalState, setModalState] = useState<ModalState>("idle");
	const [open, setOpen] = useState(false);
	const [healthResult, setHealthResult] = useState<HealthResult | null>(null);

	const client = useConvex();
	const refreshSnapshot = useMutation(api.infra.snapshots.refresh);
	const runPanelAction = useRunPanelAction();

	const readSnapshot = async <T,>(kind: "panel" | "traefik") => {
		const jobId = await refreshSnapshot({ kind });
		const job = await waitForJob(client, jobId);
		const snapshot = await client.query(api.infra.snapshots.get, { kind });
		if (job.status !== "succeeded" || !snapshot.data) {
			throw new Error(snapshot.error ?? job.error ?? `Job ${job.status}`);
		}
		return JSON.parse(snapshot.data) as T;
	};

	const checkHealth = async (): Promise<HealthResult> => {
		const [panel, traefik] = await Promise.allSettled([
			readSnapshot<PanelStatus>("panel"),
			readSnapshot<{ exists: boolean; state: string | null }>("traefik"),
		]);
		return {
			services:
				panel.status === "fulfilled"
					? panel.value.services.map((service) => ({
							name: service.name,
							status: service.running
								? { status: "healthy" as const }
								: {
										status: "unhealthy" as const,
										message:
											service.kind === "missing" ? "not found" : "not running",
									},
						}))
					: [
							{
								name: "Panara Cloud",
								status: {
									status: "unhealthy" as const,
									message: errorMessage(panel.reason),
								},
							},
						],
			traefik:
				traefik.status === "fulfilled"
					? traefik.value.state === "running"
						? { status: "healthy" }
						: {
								status: "unhealthy",
								message: traefik.value.exists
									? (traefik.value.state ?? "not running")
									: "container not found",
							}
					: { status: "unhealthy", message: errorMessage(traefik.reason) },
		};
	};

	const handleVerify = async () => {
		setModalState("checking");
		setHealthResult(null);

		try {
			setHealthResult(await checkHealth());
		} catch {
			// checkHealth failed entirely
		}
		setModalState("results");
	};

	const allHealthy =
		healthResult?.services.every(
			(service) => service.status.status === "healthy",
		) && healthResult.traefik.status === "healthy";

	const checkIsUpdateFinished = async () => {
		try {
			const response = await fetch("/api/health");
			if (!response.ok) {
				throw new Error("Health check failed");
			}

			toast.success(
				"The server has been updated. The page will be reloaded to reflect the changes...",
			);

			setTimeout(() => {
				window.location.reload();
			}, 2000);
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 2000));
			void checkIsUpdateFinished();
		}
	};

	const handleConfirm = async () => {
		try {
			setModalState("updating");
			await runPanelAction({ type: "update" });

			await new Promise((resolve) => setTimeout(resolve, 8000));

			await checkIsUpdateFinished();
		} catch (error) {
			// The reason stays in the Updates dialog behind this one (it reads
			// the last update from the backend), so this one only gets out of
			// the way.
			setOpen(false);
			setModalState("idle");
			setHealthResult(null);
			toast.error("The update failed", {
				description:
					errorMessage(error) || "No service was changed. Try again.",
			});
		}
	};

	const handleClose = () => {
		if (modalState !== "updating") {
			setOpen(false);
			setModalState("idle");
			setHealthResult(null);
		}
	};

	return (
		<AlertDialog open={open}>
			<AlertDialogTrigger
				render={
					<Button
						className={cn("w-full", buttonClassName)}
						disabledReason={disabledReason}
						onClick={() => setOpen(true)}
					/>
				}
			>
				<HardDriveDownload data-icon="inline-start" />
				{label}
			</AlertDialogTrigger>
			<AlertDialogContent className="data-[size=default]:max-w-lg data-[size=default]:sm:max-w-lg">
				<AlertDialogHeader>
					<AlertDialogTitle>
						{modalState === "idle" && "Update the panel?"}
						{modalState === "checking" && "Checking services…"}
						{modalState === "results" &&
							(allHealthy
								? "Ready to update"
								: "Some services are not healthy")}
						{modalState === "updating" && "Updating the panel"}
					</AlertDialogTitle>
					<AlertDialogDescription render={<div />}>
						{modalState === "idle" && (
							<span>
								The panel is unavailable while it updates, and this page reloads
								when it is done. Check that all services are running first.
							</span>
						)}

						{modalState === "checking" && (
							<span className="flex items-center gap-2">
								<Loader2 className="animate-spin h-4 w-4" />
								Checking the panel services and Traefik…
							</span>
						)}

						{modalState === "results" && healthResult && (
							<div className="flex flex-col gap-3">
								<div className="flex flex-col gap-2">
									{healthResult.services.map((service) => (
										<ServiceStatusItem
											key={service.name}
											name={service.name}
											service={service.status}
										/>
									))}
									<ServiceStatusItem
										name="Traefik"
										service={healthResult.traefik}
									/>
								</div>

								{!allHealthy && (
									<span className="text-sm text-warning">
										Some services are not healthy. You can still update.
									</span>
								)}

								{allHealthy && (
									<span className="text-sm text-muted-foreground">
										All services are running. You can proceed with the update.
									</span>
								)}
							</div>
						)}

						{modalState === "results" && !healthResult && (
							<span className="text-sm text-warning">
								Couldn't check the services. You can still update.
							</span>
						)}

						{modalState === "updating" && (
							<span className="flex items-center gap-2">
								<Loader2 className="animate-spin h-4 w-4" />
								This takes a minute or two.
							</span>
						)}
					</AlertDialogDescription>
				</AlertDialogHeader>
				{modalState === "idle" && (
					<AlertDialogFooter>
						<AlertDialogCancel onClick={handleClose}>Cancel</AlertDialogCancel>
						<Button variant="outline" onClick={handleVerify}>
							<RefreshCw data-icon="inline-start" />
							Check services
						</Button>
						<AlertDialogClose
							render={<AlertDialogAction onClick={handleConfirm} />}
						>
							Confirm
						</AlertDialogClose>
					</AlertDialogFooter>
				)}
				{modalState === "results" && (
					<AlertDialogFooter>
						<AlertDialogCancel onClick={handleClose}>Cancel</AlertDialogCancel>
						<Button variant="outline" onClick={handleVerify}>
							<RefreshCw data-icon="inline-start" />
							Re-check
						</Button>
						<AlertDialogClose
							render={<AlertDialogAction onClick={handleConfirm} />}
						>
							{allHealthy ? "Update" : "Update anyway"}
						</AlertDialogClose>
					</AlertDialogFooter>
				)}
			</AlertDialogContent>
		</AlertDialog>
	);
};
