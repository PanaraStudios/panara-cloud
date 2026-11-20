"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { cn } from "@/lib/utils";
import { hostId, useHostSnapshot, useWaitForJob } from "./host-jobs";

type GpuStatus = {
	driverInstalled: boolean;
	driverVersion?: string;
	gpuModel?: string;
	memoryInfo?: string;
	availableGPUs: number;
	runtimeInstalled: boolean;
	runtimeConfigured: boolean;
	cudaSupport: boolean;
	cudaVersion?: string;
	swarmEnabled: boolean;
	gpuResources: number;
};

interface GPUSupportProps {
	serverId?: string;
}

export function GPUSupport({ serverId }: GPUSupportProps) {
	const [isLoading, setIsLoading] = useState(false);

	const {
		data: gpuStatus,
		isLoading: isChecking,
		isRefreshing,
		refresh,
	} = useHostSnapshot<GpuStatus>(serverId, "gpu", {
		enabled: serverId !== undefined,
	});

	const setupGPU = useMutation(api.infra.gpu.setup);
	const waitForJob = useWaitForJob();

	const handleRefresh = async () => {
		try {
			await refresh();
		} catch {
			toast.error("Failed to refresh GPU status");
		}
	};

	const handleEnableGPU = async () => {
		if (serverId === undefined) {
			toast.error("No server selected");
			return;
		}

		setIsLoading(true);
		try {
			await waitForJob(await setupGPU({ serverId: hostId(serverId) }));
			toast.success("GPU support enabled successfully");
			await refresh();
		} catch (error) {
			toast.error(
				errorMessage(error) ||
					"Failed to enable GPU support. Please check server logs.",
			);
		} finally {
			setIsLoading(false);
		}
	};

	const statusRows = gpuStatus ? (
		<div className="grid gap-8 md:grid-cols-2">
			<div className="flex flex-col gap-2">
				<h3 className="font-medium text-small">Prerequisites</h3>
				<div className="divide-y divide-border/70 border-y border-border/70">
					<StatusRow
						label="NVIDIA driver"
						isEnabled={gpuStatus.driverInstalled}
						description={
							gpuStatus.driverVersion
								? `Installed (v${gpuStatus.driverVersion})`
								: "Not installed"
						}
					/>
					<StatusRow
						label="GPU model"
						value={gpuStatus.gpuModel || "Not detected"}
						showIcon={false}
					/>
					<StatusRow
						label="GPU memory"
						value={gpuStatus.memoryInfo || "Not available"}
						showIcon={false}
					/>
					<StatusRow
						label="Available GPUs"
						value={gpuStatus.availableGPUs || 0}
						showIcon={false}
					/>
					<StatusRow
						label="CUDA"
						isEnabled={gpuStatus.cudaSupport}
						description={
							gpuStatus.cudaVersion
								? `Available (v${gpuStatus.cudaVersion})`
								: "Not available"
						}
					/>
					<StatusRow
						label="NVIDIA Container Runtime"
						isEnabled={gpuStatus.runtimeInstalled}
						description={
							gpuStatus.runtimeInstalled ? "Installed" : "Not installed"
						}
					/>
				</div>
			</div>
			<div className="flex flex-col gap-2">
				<h3 className="font-medium text-small">Docker Swarm</h3>
				<div className="divide-y divide-border/70 border-y border-border/70">
					<StatusRow
						label="Default runtime"
						isEnabled={gpuStatus.runtimeConfigured}
						description={gpuStatus.runtimeConfigured ? "NVIDIA" : "Not set"}
					/>
					<StatusRow
						label="Swarm GPU resources"
						isEnabled={gpuStatus.swarmEnabled}
						description={
							gpuStatus.swarmEnabled
								? `Enabled (${gpuStatus.gpuResources} GPU${gpuStatus.gpuResources !== 1 ? "s" : ""})`
								: "Not enabled"
						}
					/>
				</div>
			</div>
		</div>
	) : null;

	return (
		<div className="flex flex-col gap-4">
			<SectionHeader
				title="GPU"
				description="Lets services use NVIDIA GPUs. Needs the GPU, its driver (nvidia-smi), the NVIDIA Container Runtime and CUDA on the server."
			>
				<Button
					variant="outline"
					onClick={handleRefresh}
					disabled={isChecking || isRefreshing}
				>
					<RefreshCw
						data-icon="inline-start"
						className={isChecking || isRefreshing ? "animate-spin" : ""}
					/>
					Check
				</Button>
				<DialogAction
					title="Enable GPU support?"
					description="Configures Docker Swarm on this server to hand out its GPUs. The hardware and drivers must already be installed."
					onClick={handleEnableGPU}
				>
					<Button
						variant="outline"
						isLoading={isLoading}
						disabled={isLoading || serverId === undefined || isChecking}
					>
						{gpuStatus?.swarmEnabled ? "Reconfigure GPU" : "Enable GPU"}
					</Button>
				</DialogAction>
			</SectionHeader>
			{isChecking ? (
				<div className="flex items-center gap-2 text-muted-foreground text-sm">
					<Loader2 className="size-4 animate-spin" />
					<span>Checking GPU status…</span>
				</div>
			) : (
				statusRows
			)}
		</div>
	);
}

interface StatusRowProps {
	label: string;
	isEnabled?: boolean;
	description?: string;
	value?: string | number;
	showIcon?: boolean;
}

export function StatusRow({
	label,
	isEnabled,
	description,
	value,
	showIcon = true,
}: StatusRowProps) {
	return (
		<div className="flex min-h-9 items-center justify-between gap-4 py-1.5">
			<span className="text-sm">{label}</span>
			<div className="flex items-center gap-2">
				{showIcon ? (
					<>
						<span
							className={cn(
								"size-1.5 rounded-full",
								isEnabled ? "bg-success" : "bg-muted-foreground/50",
							)}
						/>
						<span className="text-muted-foreground text-sm">
							{description || (isEnabled ? "Installed" : "Not installed")}
						</span>
					</>
				) : (
					<span className="text-sm text-muted-foreground">{value}</span>
				)}
			</div>
		</div>
	);
}
