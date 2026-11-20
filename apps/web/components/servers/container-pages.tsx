"use client";

import { api } from "@panara-cloud/backend/api";
import { useConvex, useMutation } from "convex/react";
import {
	BoxIcon,
	BracesIcon,
	CopyIcon,
	EthernetPortIcon,
	FolderSymlinkIcon,
	HardDriveIcon,
	MemoryStickIcon,
	MoreHorizontalIcon,
	NetworkIcon,
	OctagonXIcon,
	PlayIcon,
	RotateCwIcon,
	SlidersHorizontalIcon,
	SquareIcon,
	TagIcon,
	UploadIcon,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useContainerConfig } from "@/components/dashboard/docker/config/use-container-config";
import { toServerId } from "@/components/dashboard/docker/format";
import { RemoveContainerDialog } from "@/components/dashboard/docker/remove/remove-container";
import { UploadFileModal } from "@/components/dashboard/docker/upload/upload-file-modal";
import { ImageGlyph, TypeLabel } from "@/components/icons/server-icons";
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	copyToClipboard,
	EmptyState,
	Section,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { waitForJob } from "@/lib/host-data";
import { serverUrl } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import {
	type ContainerRow,
	containerStatus,
	containerUptime,
	useServerContainers,
} from "./containers-data";
import { containerHref } from "./containers-list";
import {
	DarkWell,
	DetailRows,
	FootNote,
	LinkTabs,
	ListSkeleton,
	LoadFailed,
	SectionNote,
	SectionRow,
	StatusText,
} from "./server-ui";
import { useServerRef } from "./use-server";

const DockerLogsId = dynamic(
	() =>
		import("@/components/dashboard/docker/logs/docker-logs-id").then(
			(module) => module.DockerLogsId,
		),
	{ ssr: false },
);

const DockerTerminal = dynamic(
	() =>
		import("@/components/dashboard/docker/terminal/docker-terminal").then(
			(module) => module.DockerTerminal,
		),
	{ ssr: false },
);

const FilesBrowser = dynamic(
	() =>
		import("@/components/dashboard/docker/files/files-browser").then(
			(module) => module.FilesBrowser,
		),
	{ ssr: false },
);

const sameContainer = (row: ContainerRow, containerId: string) =>
	row.containerId === containerId ||
	row.containerId.startsWith(containerId) ||
	containerId.startsWith(row.containerId) ||
	row.name === containerId;

function useContainer(containerId: string) {
	const ref = useServerRef();
	const { rows, isLoading } = useServerContainers(ref.serverId, {
		refreshInterval: 10_000,
	});
	const container = rows?.find((row) => sameContainer(row, containerId));
	return { ref, container, isLoading };
}

function useContainerAction(serverId: string | undefined) {
	const convex = useConvex();
	const run = useMutation(api.infra.docker.run);
	const [pending, setPending] = useState<string | null>(null);
	const act = async (
		type:
			| "containerRestart"
			| "containerStop"
			| "containerStart"
			| "containerKill",
		containerId: string,
		done: string,
	) => {
		setPending(type);
		try {
			const jobId = await run({
				serverId: toServerId(serverId),
				action: { type, containerId },
			});
			await waitForJob(convex, jobId);
			toast.success(done);
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setPending(null);
		}
	};
	return { act, pending };
}

/** Header and Logs · Terminal · Inspect · Files links of a container. */
export function ContainerShell({
	containerId,
	children,
}: {
	containerId: string;
	children: React.ReactNode;
}) {
	const { ref, container, isLoading } = useContainer(containerId);
	const permissions = usePermissions();
	const { act, pending } = useContainerAction(ref.serverId);
	const base = containerHref(ref.routeId, containerId);
	const status = container ? containerStatus(container) : null;
	const uptime = container ? containerUptime(container.status) : null;
	const running = container?.state === "running";
	const restarting = container?.state === "restarting";

	if (!permissions.docker.read) {
		return (
			<EmptyState
				icon={BoxIcon}
				title="Not available"
				description="Your role doesn't include this server's containers."
			/>
		);
	}

	return (
		<div className="flex w-full flex-col gap-4 pb-6">
			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0 space-y-1">
					<p className="truncate text-muted-foreground text-small">
						<Link
							href={serverUrl(ref.routeId, "containers")}
							className="hover:text-foreground"
						>
							Containers
						</Link>
						{container?.owner || container?.system ? (
							<>
								{" · "}
								{container.owner?.href ? (
									<Link
										href={container.owner.href}
										className="text-foreground hover:underline"
									>
										{container.owner.label}
									</Link>
								) : (
									<span className="text-foreground">
										{container.system ? "System" : container.owner?.label}
									</span>
								)}
							</>
						) : null}
					</p>
					<div className="flex min-w-0 flex-wrap items-center gap-3">
						<h2 className="flex min-w-0 items-center gap-2 font-semibold text-foreground text-lg">
							<ImageGlyph
								image={container?.image}
								system={container?.system}
								className="size-5"
							/>
							<span className="truncate">
								{container?.name ?? containerId.slice(0, 12)}
							</span>
						</h2>
						{status ? (
							<StatusText
								tone={status.tone}
								label={status.label}
								note={status.note}
							/>
						) : isLoading ? (
							<span className="text-muted-foreground text-sm">Loading…</span>
						) : null}
					</div>
					{container ? (
						<p className="truncate text-muted-foreground text-sm">
							<span className="font-mono text-[13px]">{container.image}</span>
							{uptime
								? ` · ${restarting ? "restarted" : "up"} ${uptime}`
								: null}
						</p>
					) : null}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{running || restarting ? (
						<>
							<Button
								variant="outline"
								isLoading={pending === "containerRestart"}
								onClick={() =>
									act("containerRestart", containerId, "Container restarted")
								}
							>
								<RotateCwIcon data-icon="inline-start" />
								Restart
							</Button>
							<Button
								variant="outline"
								isLoading={pending === "containerStop"}
								onClick={() =>
									act("containerStop", containerId, "Container stopped")
								}
							>
								<SquareIcon data-icon="inline-start" />
								Stop
							</Button>
						</>
					) : container ? (
						<Button
							variant="outline"
							isLoading={pending === "containerStart"}
							onClick={() =>
								act("containerStart", containerId, "Container started")
							}
						>
							<PlayIcon data-icon="inline-start" />
							Start
						</Button>
					) : null}
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									variant="outline"
									size="icon"
									aria-label="More container actions"
								/>
							}
						>
							<MoreHorizontalIcon />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="min-w-48">
							<DropdownMenuItem
								onClick={() =>
									copyToClipboard(container?.containerId ?? containerId, "ID")
								}
							>
								<CopyIcon />
								Copy container ID
							</DropdownMenuItem>
							<UploadFileModal
								containerId={containerId}
								serverId={ref.serverId}
							>
								<UploadIcon />
								Upload file
							</UploadFileModal>
							{running || restarting ? (
								<DropdownMenuItem
									onClick={() =>
										act("containerKill", containerId, "Container killed")
									}
								>
									<OctagonXIcon />
									Kill
								</DropdownMenuItem>
							) : null}
							<DropdownMenuSeparator />
							<RemoveContainerDialog
								containerId={containerId}
								serverId={ref.serverId}
							/>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
			<LinkTabs
				items={[
					{ label: "Logs", href: base, exact: true },
					{ label: "Terminal", href: `${base}/terminal` },
					{ label: "Inspect", href: `${base}/inspect` },
					{ label: "Files", href: `${base}/files` },
				]}
			/>
			{children}
		</div>
	);
}

export function ContainerLogsPage({ containerId }: { containerId: string }) {
	const ref = useServerRef();
	return (
		<DockerLogsId
			containerId={containerId}
			serverId={ref.serverId}
			runType="native"
			layout="page"
			listClassName="h-[calc(100svh-27.5rem)] min-h-96 rounded-xl border border-border bg-terminal text-terminal-foreground"
		/>
	);
}

export function ContainerTerminalPage({
	containerId,
}: {
	containerId: string;
}) {
	const ref = useServerRef();
	const { container } = useContainer(containerId);
	const [shell, setShell] = useState<"bash" | "sh">("bash");
	const [key, setKey] = useState(() => `container-terminal-${Date.now()}`);
	const [status, setStatus] = useState<"connecting" | "open" | "closed">(
		"connecting",
	);
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-2">
				<Select
					value={shell}
					onValueChange={(value) => setShell(value === "sh" ? "sh" : "bash")}
				>
					<SelectTrigger size="sm" className="w-40" aria-label="Shell">
						<span className="text-muted-foreground">Shell</span>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="bash">/bin/bash</SelectItem>
						<SelectItem value="sh">/bin/sh</SelectItem>
					</SelectContent>
				</Select>
				<StatusText
					className="ml-auto px-2"
					tone={
						status === "open"
							? "success"
							: status === "connecting"
								? "secondary"
								: "destructive"
					}
					label={
						status === "open"
							? "Connected"
							: status === "connecting"
								? "Connecting…"
								: "Disconnected"
					}
				/>
				<Button
					variant="outline"
					size="sm"
					onClick={() => setKey(`container-terminal-${Date.now()}`)}
				>
					<RotateCwIcon data-icon="inline-start" />
					Reconnect
				</Button>
			</div>
			<DarkWell className="h-[calc(100svh-29.5rem)] min-h-96 px-4 py-3 text-foreground">
				<DockerTerminal
					key={`${key}-${shell}`}
					id="container-terminal"
					containerId={containerId}
					serverId={ref.serverId}
					shell={shell}
					className="h-full w-full"
					onStatusChange={setStatus}
					// 127 is "command not found": slim images ship sh but no bash.
					onExit={(code) => {
						if (code === 127 && shell === "bash") setShell("sh");
					}}
				/>
			</DarkWell>
			<FootNote>
				The session ends when you leave this page. Commands run inside{" "}
				{container?.name ?? "the container"}, not on the server — for the host
				shell use the server's{" "}
				<Link
					href={serverUrl(ref.routeId, "terminal")}
					className="text-foreground underline underline-offset-2"
				>
					Terminal
				</Link>
				.
			</FootNote>
		</div>
	);
}

type Inspect = {
	Id?: string;
	Path?: string;
	Args?: string[];
	Created?: string;
	RestartCount?: number;
	State?: { StartedAt?: string; Pid?: number; OOMKilled?: boolean };
	Config?: {
		Env?: string[] | null;
		Labels?: Record<string, string> | null;
		Healthcheck?: { Test?: string[]; Interval?: number };
		ExposedPorts?: Record<string, unknown> | null;
		Image?: string;
	};
	HostConfig?: {
		RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
		NanoCpus?: number;
		Memory?: number;
	};
	Mounts?: {
		Type: string;
		Name?: string;
		Source: string;
		Destination: string;
		RW: boolean;
	}[];
	NetworkSettings?: {
		Networks?: Record<
			string,
			{ IPAddress?: string; Gateway?: string; Aliases?: string[] | null }
		>;
		Ports?: Record<string, { HostIp: string; HostPort: string }[] | null>;
	};
};

const SECRET_KEY = /SECRET|PASSWORD|PASSWD|TOKEN|KEY|DSN|CREDENTIAL|PRIVATE/i;

const isSecret = (key: string, value: string) =>
	SECRET_KEY.test(key) || /:\/\/[^/\s]*:[^@/\s]+@/.test(value);

const healthTest = (test: string[] | undefined) => {
	if (!test?.length || test[0] === "NONE") return null;
	return test[0] === "CMD-SHELL" || test[0] === "CMD"
		? test.slice(1).join(" ")
		: test.join(" ");
};

const nsToText = (ns: number | undefined) => {
	if (!ns) return null;
	const seconds = ns / 1e9;
	return seconds >= 60 ? `${seconds / 60}m` : `${seconds}s`;
};

const bytesToText = (bytes: number) =>
	bytes >= 1024 ** 3
		? `${(bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, "")} GB`
		: `${Math.round(bytes / 1024 ** 2)} MB`;

const formatDateTime = (value: string | undefined) => {
	if (!value || value.startsWith("0001")) return null;
	return new Date(value).toLocaleString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
};

function MiniTable({
	headers,
	rows,
	fit = [],
}: {
	headers: string[];
	rows: React.ReactNode[][];
	/** Columns of short values that are never cut (addresses, modes). */
	fit?: number[];
}) {
	return (
		<table className="w-full text-sm">
			<thead>
				<tr className="border-border border-b text-muted-foreground">
					{headers.map((header) => (
						<th key={header} className="py-2 pr-3 text-left font-normal">
							{header}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{rows.map((cells, index) => (
					<tr key={index} className="border-border border-b">
						{cells.map((cell, cellIndex) => (
							<td
								key={headers[cellIndex]}
								className={cn(
									"py-2.5 pr-3 align-top",
									fit.includes(cellIndex)
										? "w-px whitespace-nowrap"
										: "max-w-0 truncate",
								)}
							>
								{cell}
							</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	);
}

const mono = (value: React.ReactNode) => (
	<span className="font-mono text-[13px]">{value}</span>
);

export function ContainerInspectPage({ containerId }: { containerId: string }) {
	const ref = useServerRef();
	const { data, isLoading, error } = useContainerConfig<Inspect>(
		containerId,
		ref.serverId,
		true,
	);
	const [reveal, setReveal] = useState(false);
	const [showLabels, setShowLabels] = useState(false);
	const [raw, setRaw] = useState(false);

	const env = useMemo(
		() =>
			(data?.Config?.Env ?? []).map((line) => {
				const index = line.indexOf("=");
				return index < 0
					? { key: line, value: "" }
					: { key: line.slice(0, index), value: line.slice(index + 1) };
			}),
		[data],
	);

	if (isLoading || (!data && !error)) return <ListSkeleton />;
	if (error || !data) {
		return (
			<LoadFailed
				icon={BoxIcon}
				what="this container"
				error={error ?? "The server did not answer"}
			/>
		);
	}

	const command = [data.Path, ...(data.Args ?? [])].filter(Boolean).join(" ");
	const policy = data.HostConfig?.RestartPolicy?.Name || "no";
	const health = healthTest(data.Config?.Healthcheck?.Test);
	const limits = [
		data.HostConfig?.NanoCpus ? `${data.HostConfig.NanoCpus / 1e9} CPU` : null,
		data.HostConfig?.Memory ? bytesToText(data.HostConfig.Memory) : null,
	].filter(Boolean);
	const started = formatDateTime(data.State?.StartedAt);
	const networks = Object.entries(data.NetworkSettings?.Networks ?? {});
	const portKeys = Array.from(
		new Set([
			...Object.keys(data.Config?.ExposedPorts ?? {}),
			...Object.keys(data.NetworkSettings?.Ports ?? {}),
		]),
	);
	const labels = Object.entries(data.Config?.Labels ?? {}).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	const mounts = data.Mounts ?? [];

	return (
		<div className="flex flex-col gap-8">
			<div className="flex justify-end">
				<Button variant="outline" size="sm" onClick={() => setRaw(!raw)}>
					<BracesIcon data-icon="inline-start" />
					{raw ? "Hide raw JSON" : "Raw JSON"}
				</Button>
			</div>
			{raw ? (
				<div className="overflow-hidden rounded-xl border border-border">
					<CodeEditor
						language="json"
						lineWrapping
						readOnly
						value={JSON.stringify(data, null, 2)}
					/>
				</div>
			) : null}
			<div className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
				<div className="flex min-w-0 flex-col gap-8">
					<Section title="Config" icon={SlidersHorizontalIcon}>
						<DetailRows
							labelWidth="w-36"
							rows={[
								{
									label: "Container ID",
									value: mono((data.Id ?? containerId).slice(0, 12)),
								},
								...(command
									? [{ label: "Command", value: mono(command) }]
									: []),
								{
									label: "Restart policy",
									value: (
										<>
											{mono(policy)}
											<span className="text-muted-foreground">
												{" · "}
												{data.RestartCount ?? 0} restarts
											</span>
										</>
									),
								},
								...(health
									? [
											{
												label: "Health check",
												value: (
													<>
														{mono(health)}
														{nsToText(data.Config?.Healthcheck?.Interval) ? (
															<span className="text-muted-foreground">
																{" "}
																every{" "}
																{nsToText(data.Config?.Healthcheck?.Interval)}
															</span>
														) : null}
													</>
												),
											},
										]
									: []),
								{
									label: "Limits",
									value: limits.length ? (
										limits.join(" · ")
									) : (
										<span className="text-muted-foreground">None</span>
									),
								},
								...(started
									? [
											{
												label: "Started",
												value: (
													<>
														{started}
														{data.State?.Pid ? (
															<span className="text-muted-foreground">
																{" · "}PID {data.State.Pid}
															</span>
														) : null}
														{data.State?.OOMKilled ? (
															<span className="text-warning">
																{" · "}OOM-killed
															</span>
														) : null}
													</>
												),
											},
										]
									: []),
							]}
						/>
					</Section>
					<Section
						title="Environment"
						icon={BracesIcon}
						hint={env.length}
						actions={
							env.some((entry) => isSecret(entry.key, entry.value)) ? (
								<Button
									variant="ghost"
									size="sm"
									onClick={() => setReveal(!reveal)}
								>
									{reveal ? "Hide values" : "Reveal values"}
								</Button>
							) : null
						}
					>
						{env.length ? (
							<div className="mt-3 overflow-x-auto rounded-lg bg-muted/50 px-4 py-3 font-mono text-[13px] leading-6">
								{env.map((entry) => (
									<div key={entry.key} className="whitespace-pre">
										{entry.key}
										<span className="text-muted-foreground">
											=
											{!reveal && isSecret(entry.key, entry.value)
												? "•".repeat(12)
												: entry.value}
										</span>
									</div>
								))}
							</div>
						) : (
							<SectionNote>No variables.</SectionNote>
						)}
					</Section>
				</div>
				<div className="flex min-w-0 flex-col gap-8">
					<Section title="Mounts" icon={HardDriveIcon} hint={mounts.length}>
						{mounts.length ? (
							<MiniTable
								headers={["Type", "Source", "Destination", "RW"]}
								rows={mounts.map((mount) => [
									<TypeLabel
										key="type"
										icon={
											mount.Type === "bind"
												? FolderSymlinkIcon
												: mount.Type === "tmpfs"
													? MemoryStickIcon
													: HardDriveIcon
										}
										className="text-muted-foreground"
									>
										{mount.Type}
									</TypeLabel>,
									mono(mount.Name || mount.Source),
									mono(mount.Destination),
									mono(mount.RW ? "rw" : "ro"),
								])}
							/>
						) : (
							<SectionNote>No mounts.</SectionNote>
						)}
					</Section>
					<Section title="Networks" icon={NetworkIcon} hint={networks.length}>
						{networks.length ? (
							<MiniTable
								headers={["Network", "IP", "Gateway", "Aliases"]}
								fit={[1, 2]}
								rows={networks.map(([name, network]) => [
									mono(name),
									mono(network.IPAddress || "—"),
									<span
										key="gateway"
										className="font-mono text-[13px] text-muted-foreground"
									>
										{network.Gateway || "—"}
									</span>,
									<span
										key="aliases"
										className="font-mono text-[13px] text-muted-foreground"
									>
										{(network.Aliases ?? [])
											.filter((alias) => !containerId.startsWith(alias))
											.join(", ") || "—"}
									</span>,
								])}
							/>
						) : (
							<SectionNote>Not attached to a network.</SectionNote>
						)}
					</Section>
					<Section
						title="Ports"
						icon={EthernetPortIcon}
						hint={portKeys.length || undefined}
					>
						{portKeys.length ? (
							portKeys.map((port) => {
								const bindings = data.NetworkSettings?.Ports?.[port] ?? [];
								return (
									<SectionRow key={port} label={mono(port)}>
										{bindings.length
											? `Published on ${bindings
													.map(
														(binding) =>
															`${binding.HostIp || "0.0.0.0"}:${binding.HostPort}`,
													)
													.join(", ")}`
											: "Internal only"}
									</SectionRow>
								);
							})
						) : (
							<SectionNote>No exposed ports.</SectionNote>
						)}
					</Section>
					<Section
						title="Labels"
						icon={TagIcon}
						hint={labels.length}
						actions={
							labels.length ? (
								<Button
									variant="ghost"
									size="sm"
									onClick={() => setShowLabels(!showLabels)}
								>
									{showLabels ? "Hide" : "Show"}
								</Button>
							) : null
						}
					>
						{showLabels ? (
							<div className="flex flex-col">
								{labels.map(([key, value]) => (
									<div
										key={key}
										className="flex gap-3 border-border border-b py-2 font-mono text-xs"
									>
										<span className="w-1/2 shrink-0 break-all text-muted-foreground">
											{key}
										</span>
										<span className="min-w-0 break-all">{value}</span>
									</div>
								))}
							</div>
						) : null}
					</Section>
				</div>
			</div>
		</div>
	);
}

export function ContainerFilesPage({ containerId }: { containerId: string }) {
	const ref = useServerRef();
	const target = useMemo(
		() => ({ type: "container" as const, containerId }),
		[containerId],
	);
	return (
		<FilesBrowser
			target={target}
			serverId={ref.serverId}
			className="h-[calc(100svh-24.5rem)]"
		/>
	);
}
