"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { isConnectionFailure } from "@panara-cloud/backend/serverState";
import { useQuery } from "convex/react";
import {
	ArrowRightIcon,
	BoxIcon,
	CpuIcon,
	HardDriveIcon,
	type LucideIcon,
	MemoryStickIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { ShowDiskUsage } from "@/components/dashboard/docker/disk-usage/show-disk-usage";
import { ShowDockerEvents } from "@/components/dashboard/docker/events/show-docker-events";
import { ShowHealth } from "@/components/dashboard/docker/health/show-health";
import {
	isHostStats,
	useLiveData,
	useServiceScope,
} from "@/components/dashboard/monitoring/live-stats";
import { usePanelStatus } from "@/components/dashboard/settings/web-server/panel-actions";
import { DockerMark, ImageGlyph } from "@/components/icons/server-icons";
import { ServiceIcon } from "@/components/service/service-icon";
import { Button } from "@/components/ui/button";
import { Section, StatStrip } from "@/components/ui-kit/primitives";
import { useSnapshot } from "@/lib/host-data";
import { serverUrl, serviceUrl } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import Link from "@/lib/router/link";
import { containerStatus, isSystemContainer } from "./containers-data";
import { OverviewHeader } from "./overview-header";
import { SetupOverview } from "./overview-setup";
import { UnreachableOverview } from "./overview-unreachable";
import {
	describeFailure,
	IconStat,
	Meter,
	Notice,
	SectionNote,
	SectionRow,
	StatusText,
} from "./server-ui";
import {
	needsSetup,
	type ServerRef,
	serverStatus,
	useServerRef,
} from "./use-server";

type ContainerRow = {
	containerId: string;
	name: string;
	image: string;
	state: string;
	status: string;
};

type DiskUsageItem = {
	type: string;
	totalCount: number;
	active: number;
	size: string;
	reclaimable: string;
};

type HostStats = {
	cpuPercent: number | null;
	memoryTotal: number;
	memoryUsed: number;
	diskTotal: number | null;
	diskUsed: number | null;
};

const GB = 1e9;
const GIB = 1024 ** 3;

const SERVICE_LABEL: Record<string, string> = {
	application: "Application",
	compose: "Compose",
	postgres: "PostgreSQL",
	mysql: "MySQL",
	mariadb: "MariaDB",
	mongo: "MongoDB",
	redis: "Redis",
	libsql: "libSQL",
};

function useHostStats(ref: ServerRef) {
	const permissions = usePermissions();
	const { scope } = useServiceScope({ serverId: ref.serverId });
	const [stats, setStats] = useState<HostStats | null>(null);
	const { error } = useLiveData(
		permissions.monitoring.read
			? { kind: "containerStats", scope, target: { type: "host" } }
			: null,
		(value) => {
			if (isHostStats(value)) setStats(value as HostStats);
		},
	);
	return { stats, error };
}

function HostStat({
	icon,
	label,
	value,
	unit,
	percent,
	note,
}: {
	icon: LucideIcon;
	label: string;
	value: string;
	unit?: string;
	percent?: number | null;
	note?: React.ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-col">
			<IconStat icon={icon} label={label} className="pb-2">
				<span>{value}</span>
				{unit ? (
					<span className="truncate font-normal text-muted-foreground text-sm">
						{unit}
					</span>
				) : null}
			</IconStat>
			<div className="flex min-h-5 flex-col justify-center px-4 pb-3">
				{percent !== undefined ? <Meter percent={percent} /> : null}
				{note ? <p className="truncate text-caption">{note}</p> : null}
			</div>
		</div>
	);
}

function HostStats({
	info: serverRef,
	containers,
}: {
	info: ServerRef;
	containers: ContainerRow[] | undefined;
}) {
	const { stats } = useHostStats(serverRef);
	const running = (containers ?? []).filter(
		(container) => container.state === "running",
	).length;
	const restarting = (containers ?? []).filter(
		(container) => container.state === "restarting",
	);
	const memTotal = stats ? stats.memoryTotal / GIB : null;
	const memUsed = stats ? stats.memoryUsed / GIB : null;
	const diskTotal = stats?.diskTotal ? stats.diskTotal / GB : null;
	const diskUsed = stats?.diskUsed ? stats.diskUsed / GB : null;
	return (
		<StatStrip>
			<HostStat
				icon={CpuIcon}
				label="CPU"
				value={
					stats?.cpuPercent != null ? `${Math.round(stats.cpuPercent)}%` : "—"
				}
				percent={stats?.cpuPercent ?? null}
			/>
			<HostStat
				icon={MemoryStickIcon}
				label="Memory"
				value={memUsed != null ? memUsed.toFixed(1) : "—"}
				unit={memTotal ? `of ${Math.round(memTotal)} GB` : undefined}
				percent={memUsed && memTotal ? (memUsed / memTotal) * 100 : null}
			/>
			<HostStat
				icon={HardDriveIcon}
				label="Disk"
				value={diskUsed != null ? `${Math.round(diskUsed)}` : "—"}
				unit={diskTotal ? `of ${Math.round(diskTotal)} GB` : undefined}
				percent={diskUsed && diskTotal ? (diskUsed / diskTotal) * 100 : null}
			/>
			<HostStat
				icon={BoxIcon}
				label="Containers"
				value={containers ? String(containers.length) : "—"}
				unit={containers ? `${running} running` : undefined}
				note={
					restarting.length > 0 ? (
						<span className="text-warning">
							{restarting.length} restarting ·{" "}
							<span className="font-mono text-[13px]">
								{restarting
									.map((container) => container.name.replace(/^\//, ""))
									.join(", ")}
							</span>
						</span>
					) : undefined
				}
			/>
		</StatStrip>
	);
}

const SHOWN_CONTAINERS = 8;

function RunningHere({
	info: serverRef,
	containers,
	dockerDown,
}: {
	info: ServerRef;
	containers: ContainerRow[] | undefined;
	dockerDown: boolean;
}) {
	const permissions = usePermissions();
	const services = useQuery(
		api.servers.services,
		serverRef.serverId
			? { serverId: serverRef.serverId as Id<"servers"> }
			: "skip",
	);
	const containersUrl = serverUrl(serverRef.routeId, "containers");
	// Swarm keeps the stopped containers of earlier deploys around; they would
	// push what actually runs off this short list.
	const live = (containers ?? []).filter(
		(container) => container.state !== "exited" && container.state !== "dead",
	);
	const shown = [...(live.length > 0 ? live : (containers ?? []))]
		.sort(
			(a, b) =>
				Number(b.state === "restarting") - Number(a.state === "restarting") ||
				a.name.localeCompare(b.name),
		)
		.slice(0, SHOWN_CONTAINERS);
	return (
		<Section
			title="Running here"
			icon={BoxIcon}
			hint={
				serverRef.serverId
					? services?.length
						? `${services.length} ${services.length === 1 ? "service" : "services"}`
						: undefined
					: "The panel, Traefik and every service with no server set"
			}
			actions={
				permissions.docker.read && !dockerDown ? (
					<Link
						href={containersUrl}
						className="inline-flex shrink-0 items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
					>
						All containers <ArrowRightIcon className="size-3.5" />
					</Link>
				) : null
			}
		>
			{serverRef.serverId ? (
				services === undefined ? (
					<SectionNote>Loading…</SectionNote>
				) : services.length === 0 ? (
					<SectionNote>
						No services are deployed to this server yet.
					</SectionNote>
				) : (
					services.map((service) => (
						<SectionRow
							key={service.id}
							label={
								<span className="flex min-w-0 items-center gap-2">
									<ServiceIcon kind={service.type} />
									<Link
										href={serviceUrl({
											projectId: service.projectId,
											environmentId: service.environmentId,
											kind: service.type,
											id: service.id,
										})}
										className="truncate font-medium hover:underline"
									>
										{service.name}
									</Link>
								</span>
							}
						>
							{SERVICE_LABEL[service.type] ?? service.type}
						</SectionRow>
					))
				)
			) : !permissions.docker.read ? (
				<SectionNote>
					Your role doesn't include this server's containers.
				</SectionNote>
			) : containers === undefined ? (
				<SectionNote>Loading…</SectionNote>
			) : containers.length === 0 ? (
				<SectionNote>Nothing is running on this server yet.</SectionNote>
			) : (
				<>
					{shown.map((container) => {
						const status = containerStatus(container);
						const name = container.name.replace(/^\//, "");
						return (
							<SectionRow
								key={container.containerId}
								label={
									<span className="flex min-w-0 items-center gap-2">
										<ImageGlyph
											image={container.image}
											system={isSystemContainer(name)}
										/>
										<Link
											href={`${containersUrl}/${encodeURIComponent(container.containerId)}`}
											className="truncate font-mono text-[13px] hover:underline"
										>
											{name}
										</Link>
									</span>
								}
							>
								<StatusText
									tone={status.tone}
									label={status.label}
									note={status.note}
									className="text-foreground"
								/>
							</SectionRow>
						);
					})}
					{containers.length > shown.length ? (
						<SectionNote>
							{containers.length - shown.length} more in{" "}
							<Link
								href={containersUrl}
								className="text-foreground underline underline-offset-2"
							>
								Containers
							</Link>
							.
						</SectionNote>
					) : null}
				</>
			)}
		</Section>
	);
}

function DockerDisk({
	info: serverRef,
	cleanupOn,
}: {
	info: ServerRef;
	cleanupOn: boolean | undefined;
}) {
	const permissions = usePermissions();
	const snapshot = useSnapshot<DiskUsageItem[]>(
		serverRef.serverId,
		"diskUsage",
	);
	const byType = new Map(
		(snapshot.data ?? []).map((item) => [item.type, item]),
	);
	const rows: { label: string; type: string }[] = [
		{ label: "Images", type: "Images" },
		{ label: "Build cache", type: "Build Cache" },
		{ label: "Volumes", type: "Local Volumes" },
	];
	const failed = !!snapshot.error && !snapshot.data;
	return (
		<Section
			title="Docker disk"
			icon={DockerMark}
			actions={
				permissions.server.create ? (
					<Button
						size="sm"
						variant="outline"
						nativeButton={false}
						render={
							<Link href={serverUrl(serverRef.routeId, "settings/docker")} />
						}
					>
						Clean up…
					</Button>
				) : null
			}
		>
			{failed ? (
				<SectionNote>
					{describeFailure(snapshot.error ?? "", "disk usage").sentence}
				</SectionNote>
			) : (
				rows.map((row) => {
					const item = byType.get(row.type);
					return (
						<SectionRow key={row.type} label={row.label}>
							{item ? (
								<>
									{item.size}
									{" · "}
									<span className="text-foreground">
										{item.reclaimable} unused
									</span>
								</>
							) : (
								"…"
							)}
						</SectionRow>
					);
				})
			)}
			<SectionRow label="Daily clean-up">
				{cleanupOn === undefined ? "…" : cleanupOn ? "On" : "Off"}
			</SectionRow>
		</Section>
	);
}

function ReadyOverview({
	refInfo,
	containers,
	dockerError,
	onRetry,
	retrying,
}: {
	refInfo: ServerRef;
	containers: ContainerRow[] | undefined;
	dockerError: string | null;
	onRetry: () => void;
	retrying: boolean;
}) {
	const permissions = usePermissions();
	const web = useQuery(api.infra.webServer.get, refInfo.isLocal ? {} : "skip");
	const { data: panel } = usePanelStatus({ refreshOnMount: refInfo.isLocal });
	const status = refInfo.server
		? serverStatus(refInfo.server)
		: ({ label: "Ready", tone: "success" } as const);
	const canSeeHealth = permissions.docker.read && permissions.server.read;
	const cleanupOn = refInfo.isLocal
		? web?.enableDockerCleanup
		: refInfo.server?.enableDockerCleanup;
	const dockerDown = dockerError !== null;
	const showDocker = permissions.docker.read && !dockerDown;
	const failure = dockerError
		? describeFailure(dockerError, "containers")
		: null;

	return (
		<div className="flex w-full flex-col gap-8 pb-10">
			<OverviewHeader
				status={
					dockerDown
						? { tone: "warning", label: "Docker not answering" }
						: { tone: status.tone, label: status.label }
				}
			/>
			{failure ? (
				<Notice
					title={failure.sentence}
					action={
						<Button
							variant="outline"
							size="sm"
							isLoading={retrying}
							onClick={onRetry}
						>
							Try again
						</Button>
					}
				>
					<p>
						Containers, disk usage, events and diagnostics are hidden until it
						answers.
					</p>
					{failure.raw ? (
						<p className="break-all font-mono text-[12px] text-muted-foreground">
							{failure.raw}
						</p>
					) : null}
				</Notice>
			) : null}
			<HostStats info={refInfo} containers={containers} />
			<div
				className={
					showDocker
						? "grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
						: undefined
				}
			>
				{dockerDown && refInfo.isLocal ? null : (
					<RunningHere
						info={refInfo}
						containers={containers}
						dockerDown={dockerDown}
					/>
				)}
				{showDocker ? (
					<DockerDisk info={refInfo} cleanupOn={cleanupOn} />
				) : null}
			</div>
			{showDocker ? (
				<>
					<ShowDiskUsage serverId={refInfo.serverId} />
					<ShowDockerEvents serverId={refInfo.serverId} />
					{canSeeHealth ? <ShowHealth serverId={refInfo.serverId} /> : null}
				</>
			) : null}
		</div>
	);
}

export function ServerOverview() {
	const ref = useServerRef();
	const permissions = usePermissions();
	const status = ref.server ? serverStatus(ref.server) : null;
	const setUp = ref.isLocal || (status !== null && !needsSetup(status));
	const containers = useSnapshot<ContainerRow[]>(ref.serverId, "containers", {
		enabled: setUp && permissions.docker.read,
		refreshInterval: 30_000,
	});
	const [retrying, setRetrying] = useState(false);

	const unreachable = useMemo(() => {
		if (ref.isLocal || !ref.server || !setUp) return null;
		if (ref.server.serverStatus === "inactive") return null;
		if (containers.error && isConnectionFailure(containers.error))
			return containers.error;
		if (status?.label === "Unreachable")
			return ref.server.lastValidation?.details ?? "Connection failed";
		return null;
	}, [ref.isLocal, ref.server, setUp, containers.error, status?.label]);

	if (!ref.isLocal && !ref.server) return null;
	if (!setUp) return <SetupOverview refInfo={ref} />;
	if (unreachable)
		return (
			<UnreachableOverview
				refInfo={ref}
				error={unreachable.split("\n")[0] ?? unreachable}
				since={
					containers.refreshedAt ??
					ref.server?.lastValidation?.checkedAt ??
					null
				}
				retrying={retrying || containers.isRefreshing}
				onRetry={() => {
					setRetrying(true);
					containers.refresh().finally(() => setRetrying(false));
				}}
			/>
		);
	return (
		<ReadyOverview
			refInfo={ref}
			containers={containers.data}
			dockerError={
				containers.error && !containers.data ? containers.error : null
			}
			retrying={retrying || containers.isRefreshing}
			onRetry={() => {
				setRetrying(true);
				containers.refresh().finally(() => setRetrying(false));
			}}
		/>
	);
}
