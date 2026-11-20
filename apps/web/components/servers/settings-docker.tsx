"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { MinusIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ShowStorageActions } from "@/components/dashboard/settings/servers/actions/show-storage-actions";
import { ShowTraefikActions } from "@/components/dashboard/settings/servers/actions/show-traefik-actions";
import {
	hostId,
	useHostSnapshot,
	useWaitForJob,
} from "@/components/dashboard/settings/servers/host-jobs";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/auth/errors";
import { CheckRow, SettingRow, SettingsBlock } from "./server-settings";
import { FailureNote, FootNote } from "./server-ui";
import { useServerRef } from "./use-server";

const MAX_CONCURRENCY = 100;

function ConcurrencyStepper() {
	const ref = useServerRef();
	const local = useQuery(
		api.infra.webServer.getLocalBuildsConcurrency,
		ref.isLocal ? {} : "skip",
	);
	const current = ref.isLocal ? local : ref.server?.buildsConcurrency;
	const setServer = useMutation(api.servers.setBuildsConcurrency);
	const setLocal = useMutation(api.infra.webServer.setLocalBuildsConcurrency);
	const [value, setValue] = useState<number | null>(null);
	const shown = value ?? current ?? 1;

	useEffect(() => {
		if (value === null || value === current) return;
		const timer = setTimeout(() => {
			(ref.isLocal
				? setLocal({ buildsConcurrency: value })
				: setServer({
						serverId: ref.serverId as Id<"servers">,
						buildsConcurrency: value,
					})
			)
				.then(() => toast.success(`Up to ${value} builds at once`))
				.catch((error) => toast.error(errorMessage(error)))
				.finally(() => setValue(null));
		}, 600);
		return () => clearTimeout(timer);
	}, [value, current, ref.isLocal, ref.serverId, setLocal, setServer]);

	const step = (delta: number) =>
		setValue(Math.min(MAX_CONCURRENCY, Math.max(1, shown + delta)));

	return (
		<div className="flex h-8 items-center rounded-lg border border-input bg-field">
			<button
				type="button"
				aria-label="Fewer builds"
				className="flex h-full w-8 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-40"
				disabled={shown <= 1}
				onClick={() => step(-1)}
			>
				<MinusIcon className="size-3.5" />
			</button>
			<span className="w-8 text-center text-sm tabular-nums">{shown}</span>
			<button
				type="button"
				aria-label="More builds"
				className="flex h-full w-8 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-40"
				disabled={shown >= MAX_CONCURRENCY}
				onClick={() => step(1)}
			>
				<PlusIcon className="size-3.5" />
			</button>
		</div>
	);
}

function CleanupToggle() {
	const ref = useServerRef();
	const web = useQuery(api.infra.webServer.get, ref.isLocal ? {} : "skip");
	const enabled = ref.isLocal
		? web?.enableDockerCleanup
		: ref.server?.enableDockerCleanup;
	const setCleanup = useMutation(api.infra.docker.setDockerCleanup);
	return (
		<Switch
			aria-label="Clean up daily"
			checked={Boolean(enabled)}
			onCheckedChange={(checked) =>
				setCleanup({ enabled: checked, serverId: hostId(ref.serverId) })
					.then(() =>
						toast.success(checked ? "Daily cleanup on" : "Daily cleanup off"),
					)
					.catch((error) => toast.error(errorMessage(error)))
			}
		/>
	);
}

export function DockerSettings() {
	const ref = useServerRef();
	const isBuild = ref.server?.serverType === "build";
	return (
		<div className="flex flex-col gap-8">
			<SettingsBlock title="Docker cleanup">
				<SettingRow
					label="Clean up daily"
					description="Removes stopped containers, unused images and build cache. Volumes are never touched."
				>
					<CleanupToggle />
				</SettingRow>
				<SettingRow
					label="Clean up now"
					description="Free disk space taken by unused images, volumes, stopped containers and build cache."
				>
					<ShowStorageActions serverId={ref.serverId} />
				</SettingRow>
			</SettingsBlock>

			<SettingsBlock title="Builds">
				<SettingRow
					label="Concurrent builds"
					description="More builds at once finish sooner but compete with running apps for CPU. Builds of one service always run one at a time."
				>
					<ConcurrencyStepper />
				</SettingRow>
			</SettingsBlock>

			{isBuild ? null : (
				<SettingsBlock title="Traefik">
					<SettingRow
						label="Traefik on this server"
						description="Reload it, change its environment or map extra ports."
					>
						<ShowTraefikActions serverId={ref.serverId} />
					</SettingRow>
				</SettingsBlock>
			)}

			<FootNote className="border-border border-t pt-6">
				Changes apply to the server right away.
			</FootNote>
		</div>
	);
}

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

export function GpuSettings() {
	const ref = useServerRef();
	const canCheck = ref.isLocal || Boolean(ref.server?.sshKeyId);
	const { data, error, isLoading, isRefreshing, refresh } =
		useHostSnapshot<GpuStatus>(ref.serverId, "gpu", { enabled: canCheck });
	const setupGpu = useMutation(api.infra.gpu.setup);
	const waitForJob = useWaitForJob();
	const [enabling, setEnabling] = useState(false);

	if (!canCheck)
		return (
			<FootNote>Assign an SSH key in Connection to check this server.</FootNote>
		);

	const enable = async () => {
		setEnabling(true);
		try {
			await waitForJob(await setupGpu({ serverId: hostId(ref.serverId) }));
			toast.success("GPU support enabled");
			await refresh();
		} catch (failure) {
			toast.error(errorMessage(failure));
		} finally {
			setEnabling(false);
		}
	};

	const hasGpu = (data?.availableGPUs ?? 0) > 0;
	return (
		<div className="flex flex-col gap-8">
			<SettingsBlock
				title="NVIDIA GPU"
				description="Lets services request a GPU. Needs the driver and container runtime on the server."
				actions={
					<>
						<Button
							variant="ghost"
							size="sm"
							isLoading={isRefreshing}
							onClick={() => refresh().catch(() => undefined)}
						>
							Re-check
						</Button>
						<DialogAction
							title="Enable GPU support?"
							type="default"
							description="Installs the NVIDIA container runtime and registers the server's GPUs with Swarm."
							onClick={enable}
						>
							<Button
								variant="outline"
								size="sm"
								isLoading={enabling}
								disabled={!data}
							>
								{data?.swarmEnabled ? "Reconfigure GPU" : "Enable GPU support"}
							</Button>
						</DialogAction>
					</>
				}
			>
				{error ? (
					<FailureNote className="py-0" error={error} what="the GPU status" />
				) : isLoading || !data ? (
					<FootNote>Checking GPU status…</FootNote>
				) : (
					<div>
						<div className="grid gap-x-8 border-border border-t sm:grid-cols-2">
							<div className="flex flex-col">
								<CheckRow
									state={data.driverInstalled ? "ok" : "fail"}
									label="NVIDIA driver"
									value={
										data.driverInstalled
											? (data.driverVersion ?? "installed")
											: "not found"
									}
								/>
								<CheckRow
									state={data.runtimeInstalled ? "ok" : "fail"}
									label="Container runtime"
									value={
										data.runtimeInstalled
											? data.runtimeConfigured
												? "installed · default"
												: "installed"
											: "not installed"
									}
								/>
								<CheckRow
									state={data.cudaSupport ? "ok" : "none"}
									label="CUDA"
									value={data.cudaSupport ? (data.cudaVersion ?? "yes") : "—"}
								/>
							</div>
							<div className="flex flex-col">
								<CheckRow
									state={hasGpu ? "ok" : "none"}
									label="GPUs found"
									value={
										hasGpu
											? `${data.availableGPUs}${data.gpuModel ? ` · ${data.gpuModel}` : ""}`
											: "0"
									}
								/>
								<CheckRow
									state={data.swarmEnabled ? "ok" : "none"}
									label="Swarm GPU resources"
									value={
										data.swarmEnabled
											? `${data.gpuResources} GPU${data.gpuResources === 1 ? "" : "s"}`
											: "off"
									}
								/>
								{data.memoryInfo ? (
									<CheckRow
										state="none"
										label="GPU memory"
										value={data.memoryInfo}
									/>
								) : null}
							</div>
						</div>
						{hasGpu ? null : (
							<FootNote className="pt-3">
								{ref.name ?? "This server"} has no GPU hardware. Enabling
								installs the runtime and registers GPUs with Swarm once a card
								is present.
							</FootNote>
						)}
					</div>
				)}
			</SettingsBlock>
		</div>
	);
}
