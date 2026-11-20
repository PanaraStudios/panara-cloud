"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import {
	ArrowLeftIcon,
	BlocksIcon,
	BoxIcon,
	BracesIcon,
	CopyIcon,
	EyeIcon,
	EyeOffIcon,
	ServerIcon,
	TagIcon,
	TicketIcon,
	UnplugIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AddNode } from "@/components/dashboard/settings/cluster/nodes/add-node";
import {
	hostId,
	useWaitForJob,
	useWaitForOp,
} from "@/components/dashboard/settings/servers/host-jobs";
import {
	useSwarmNodes,
	useSwarmServices,
} from "@/components/dashboard/swarm/use-swarm-data";
import { swarmRoleIcon, TypeLabel } from "@/components/icons/server-icons";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	CodeWell,
	ConfirmDialog,
	copyToClipboard,
	EmptyState,
	MoreMenu,
	PageHeader,
	ResourceTable,
	Section,
	StatCell,
	StatStrip,
	Th,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { useDockerInspectQuery } from "@/lib/host-data";
import { serverUrl } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import {
	DetailRows,
	FailureNote,
	FootNote,
	ListSkeleton,
	LoadFailed,
	SectionNote,
	StatusText,
} from "./server-ui";
import { useServerRef } from "./use-server";

type SwarmNode = NonNullable<ReturnType<typeof useSwarmNodes>["raw"]>[number];
type SwarmTask = NonNullable<
	ReturnType<typeof useSwarmServices>["tasks"]
>[number];

const capitalize = (value: string) =>
	value ? value.charAt(0).toUpperCase() + value.slice(1) : value;

const isRunning = (state: string) => /^running/i.test(state);

// `docker service ps` prints "Running 2 hours ago": the state, then since when.
const splitState = (currentState: string) => {
	const match = /^(\S+)\s+(.*?)(?:\s+ago)?$/.exec(currentState.trim());
	return match
		? { state: match[1] ?? currentState, since: match[2] ?? "" }
		: { state: currentState, since: "" };
};

const tasksOn = (tasks: SwarmTask[] | undefined, node: SwarmNode) =>
	(tasks ?? []).filter(
		(task) => task.Node === node.hostname || task.Node === node.id,
	);

function nodeStatus(node: SwarmNode) {
	const ready = node.status.toLowerCase() === "ready";
	return {
		tone: ready ? ("success" as const) : ("destructive" as const),
		label: capitalize(node.status),
	};
}

function Availability({ value }: { value: string }) {
	const label = value.toLowerCase() === "drain" ? "Drained" : capitalize(value);
	return (
		<span className={cn(value.toLowerCase() !== "active" && "text-warning")}>
			{label}
		</span>
	);
}

function roleLabel(node: SwarmNode) {
	if (node.role !== "manager") return { role: "Worker", note: "" };
	return {
		role: "Manager",
		note: node.managerStatus ? node.managerStatus.toLowerCase() : "",
	};
}

const formatMemory = (bytes: number) => `${Math.round(bytes / 1024 ** 3)} GB`;
const formatCpus = (nanoCpus: number) => `${Math.round(nanoCpus / 1e9)} vCPU`;

function useSelfNode(nodes: SwarmNode[] | undefined) {
	const ref = useServerRef();
	return nodes?.find(
		(node) =>
			(ref.ipAddress && node.addr === ref.ipAddress) ||
			(ref.name && node.hostname === ref.name),
	);
}

function Allowed({ children }: { children: React.ReactNode }) {
	const permissions = usePermissions();
	if (!permissions.docker.read) {
		return (
			<EmptyState
				icon={BlocksIcon}
				title="Not available"
				description="Your role doesn't include this part of the server."
			/>
		);
	}
	return children;
}

export function ServerSwarmPage() {
	return (
		<Allowed>
			<SwarmOverview />
		</Allowed>
	);
}

function SwarmOverview() {
	const ref = useServerRef();
	const permissions = usePermissions();
	const { active } = useOrganization();
	const nodes = useSwarmNodes(ref.serverId);
	const services = useSwarmServices(ref.serverId);
	const registries = useQuery(api.sources.registries.list, {
		organizationId: active.id,
	});
	const self = useSelfNode(nodes.raw);
	const list = nodes.raw ?? [];
	const managers = list.filter((node) => node.role === "manager").length;
	const desired = (services.tasks ?? []).filter((task) =>
		isRunning(task.DesiredState),
	);
	const running = desired.filter((task) => isRunning(task.CurrentState));
	const cluster = list.length
		? `${self?.role === "manager" ? "manager of a" : self ? "worker in a" : "a"} ${list.length}-node cluster`
		: undefined;

	const canAddNode =
		permissions.server.create && !!registries && registries.length > 0;

	return (
		<div className="flex w-full flex-col gap-6 pb-10">
			{cluster || canAddNode ? (
				<div className="flex min-h-9 flex-wrap items-center gap-2">
					{cluster ? (
						<p className="text-muted-foreground text-sm first-letter:uppercase">
							{cluster}
						</p>
					) : null}
					{canAddNode ? (
						<div className="ml-auto">
							<AddNode serverId={ref.serverId} />
						</div>
					) : null}
				</div>
			) : null}
			{nodes.isLoading ? (
				<ListSkeleton rows={3} />
			) : nodes.error && !/^Docker Swarm is /.test(nodes.error) ? (
				<LoadFailed
					icon={BlocksIcon}
					what="swarm nodes"
					error={nodes.error}
					onRetry={() => void nodes.refresh()}
				/>
			) : !nodes.raw ? (
				<EmptyState
					icon={BlocksIcon}
					title="Swarm isn't running"
					description={
						nodes.error
							? `${nodes.error}. Setup initializes it.`
							: "Docker Swarm isn't active on this server. Setup initializes it."
					}
				/>
			) : (
				<>
					<StatStrip>
						<Stat
							label="Nodes"
							value={list.length}
							detail={`${managers} ${managers === 1 ? "manager" : "managers"} · ${list.length - managers} ${list.length - managers === 1 ? "worker" : "workers"}`}
						/>
						<Stat
							label="Tasks"
							value={running.length}
							detail={`running of ${desired.length} desired`}
						/>
						<Stat label="Services" value={services.services?.length ?? 0} />
					</StatStrip>
					<Section title="Nodes" icon={ServerIcon} hint={list.length}>
						<ResourceTable
							className="pt-4"
							headers={
								<>
									<Th>Node</Th>
									<Th>Role</Th>
									<Th>Status</Th>
									<Th>Availability</Th>
									<Th>Engine</Th>
									<Th>Tasks</Th>
								</>
							}
						>
							{list.map((node) => (
								<NodeRow
									key={node.id}
									node={node}
									isSelf={node.id === self?.id}
									tasks={tasksOn(services.tasks, node).filter((task) =>
										isRunning(task.DesiredState),
									)}
									href={serverUrl(
										ref.routeId,
										`swarm/${encodeURIComponent(node.id)}`,
									)}
								/>
							))}
						</ResourceTable>
						{permissions.server.create &&
						registries &&
						registries.length === 0 ? (
							<FootNote className="pt-3">
								To add nodes, add a registry first in{" "}
								<Link
									href="/settings/registries"
									className="text-foreground underline underline-offset-2"
								>
									Settings › Registries
								</Link>
								: nodes pull images from it.
							</FootNote>
						) : null}
					</Section>
					{permissions.server.create ? (
						<JoinTokens serverId={ref.serverId} />
					) : null}
				</>
			)}
		</div>
	);
}

function Stat({
	label,
	value,
	detail,
}: {
	label: string;
	value: number;
	detail?: string;
}) {
	return (
		<StatCell label={label} big>
			<span>{value}</span>
			{detail ? (
				<span className="truncate font-normal text-muted-foreground text-sm">
					{detail}
				</span>
			) : null}
		</StatCell>
	);
}

function NodeRow({
	node,
	isSelf,
	tasks,
	href,
}: {
	node: SwarmNode;
	isSelf: boolean;
	tasks: SwarmTask[];
	href: string;
}) {
	const router = useRouter();
	const status = nodeStatus(node);
	const { role, note } = roleLabel(node);
	return (
		<TableRow
			className="cursor-pointer"
			onClick={() => router.push(href)}
			onKeyDown={(event) => {
				if (event.key === "Enter") router.push(href);
			}}
			tabIndex={0}
		>
			<TableCell>
				<Link
					href={href}
					className="font-medium hover:underline"
					onClick={(event) => event.stopPropagation()}
				>
					{node.hostname}
				</Link>
				{isSelf ? (
					<span className="text-muted-foreground text-sm"> · this server</span>
				) : null}
				{node.addr ? (
					<div className="font-mono text-[13px] text-muted-foreground">
						{node.addr}
					</div>
				) : null}
			</TableCell>
			<TableCell>
				<TypeLabel icon={swarmRoleIcon(node.role)}>
					<span>
						{role}
						{note ? (
							<span className="text-muted-foreground text-sm"> · {note}</span>
						) : null}
					</span>
				</TypeLabel>
			</TableCell>
			<TableCell>
				<StatusText tone={status.tone} label={status.label} />
			</TableCell>
			<TableCell>
				<Availability value={node.availability} />
			</TableCell>
			<TableCell className="font-mono text-[13px] text-muted-foreground">
				{node.engineVersion}
			</TableCell>
			<TableCell
				className={cn("tabular-nums", !tasks.length && "text-muted-foreground")}
			>
				{tasks.length}
			</TableCell>
		</TableRow>
	);
}

type JoinInfo = { address: string; worker: string; manager: string };

// One `clusterJoinInfo` op reads both join commands (admins only).
function useJoinInfo(serverId: string | undefined) {
	const runDocker = useMutation(api.infra.docker.run);
	const waitForOp = useWaitForOp();
	const [state, setState] = useState<
		{ info?: JoinInfo; error?: string } | undefined
	>();
	useEffect(() => {
		let cancelled = false;
		setState(undefined);
		runDocker({
			serverId: hostId(serverId),
			action: { type: "clusterJoinInfo" },
		})
			.then((jobId) => waitForOp<JoinInfo>(jobId))
			.then(
				(info) => !cancelled && setState({ info }),
				(error: unknown) =>
					!cancelled && setState({ error: errorMessage(error) }),
			);
		return () => {
			cancelled = true;
		};
	}, [runDocker, waitForOp, serverId]);
	return state;
}

const maskToken = (command: string) =>
	command.replace(
		/(SWMTKN-1-\w{4})(\w+)(\w{4})/,
		(_, start: string, middle: string, end: string) =>
			`${start}${"•".repeat(Math.min(middle.length, 24))}${end}`,
	);

function JoinTokens({ serverId }: { serverId: string | undefined }) {
	const state = useJoinInfo(serverId);
	return (
		<Section
			title="Join tokens"
			icon={TicketIcon}
			hint="Run on a new machine to add it to this cluster"
		>
			{state === undefined ? (
				<SectionNote>Reading the join tokens…</SectionNote>
			) : state.error || !state.info ? (
				<FailureNote
					error={state.error ?? "No answer"}
					what="the join tokens"
				/>
			) : (
				<>
					<TokenRow label="Worker" command={state.info.worker} />
					<TokenRow label="Manager" command={state.info.manager} />
				</>
			)}
			<FootNote className="pt-3">
				Prefer Add node: it walks you through Docker and the registry too.
			</FootNote>
		</Section>
	);
}

function TokenRow({ label, command }: { label: string; command: string }) {
	const [revealed, setRevealed] = useState(false);
	return (
		<div className="flex min-h-11 items-center gap-4 border-border border-b py-2 text-sm">
			<span className="w-24 shrink-0 text-muted-foreground">{label}</span>
			<code className="min-w-0 flex-1 truncate font-mono text-[13px]">
				{revealed ? command : maskToken(command)}
			</code>
			<div className="flex shrink-0 items-center gap-1">
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setRevealed((value) => !value)}
				>
					{revealed ? (
						<EyeOffIcon data-icon="inline-start" />
					) : (
						<EyeIcon data-icon="inline-start" />
					)}
					{revealed ? "Hide" : "Reveal"}
				</Button>
				<Button
					variant="outline"
					size="sm"
					onClick={() => copyToClipboard(command, `${label} join command`)}
				>
					<CopyIcon data-icon="inline-start" />
					Copy
				</Button>
			</div>
		</div>
	);
}

type NodeInspect = {
	ID?: string;
	Spec?: { Labels?: Record<string, string> };
	Description?: { Platform?: { OS?: string; Architecture?: string } };
};

export function SwarmNodePage({ nodeId }: { nodeId: string }) {
	return (
		<Allowed>
			<SwarmNode nodeId={nodeId} />
		</Allowed>
	);
}

function SwarmNode({ nodeId }: { nodeId: string }) {
	const ref = useServerRef();
	const router = useRouter();
	const permissions = usePermissions();
	const nodes = useSwarmNodes(ref.serverId);
	const services = useSwarmServices(ref.serverId);
	const node = nodes.raw?.find(
		(item) => item.id === nodeId || item.hostname === nodeId,
	);
	const inspect = useDockerInspectQuery<NodeInspect>(
		ref.serverId,
		node ? { type: "nodeInspect", nodeId: node.id } : null,
	);
	const runDocker = useMutation(api.infra.docker.run);
	const waitForJob = useWaitForJob();
	const [removeOpen, setRemoveOpen] = useState(false);
	const [showRaw, setShowRaw] = useState(false);
	const tasks = useMemo(
		() => (node ? tasksOn(services.tasks, node) : []),
		[services.tasks, node],
	);
	const listHref = serverUrl(ref.routeId, "swarm");

	if (nodes.isLoading) return <ListSkeleton rows={3} />;
	if (!node) {
		return (
			<EmptyState
				icon={BlocksIcon}
				title="Node not found"
				description="It may have left the swarm."
			>
				<Button
					variant="outline"
					nativeButton={false}
					render={<Link href={listHref} />}
				>
					Back to Swarm
				</Button>
			</EmptyState>
		);
	}

	const status = nodeStatus(node);
	const { role, note } = roleLabel(node);
	const labels = Object.entries(inspect.data?.Spec?.Labels ?? {});
	const os = inspect.data?.Description?.Platform?.OS ?? "linux";
	const canRemove =
		permissions.server.delete && node.managerStatus.toLowerCase() !== "leader";

	return (
		<div className="flex w-full flex-col gap-8 pb-10">
			<Link
				href={listHref}
				className="-mb-6 inline-flex w-fit items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground"
			>
				<ArrowLeftIcon className="size-3.5" />
				Swarm
			</Link>
			<PageHeader title={node.hostname}>
				<Button variant="outline" onClick={() => setShowRaw((value) => !value)}>
					<BracesIcon data-icon="inline-start" />
					{showRaw ? "Hide raw JSON" : "Raw JSON"}
				</Button>
				{canRemove ? (
					<MoreMenu>
						<DropdownMenuItem
							variant="destructive"
							onClick={() => setRemoveOpen(true)}
						>
							<UnplugIcon />
							Remove from swarm
						</DropdownMenuItem>
					</MoreMenu>
				) : null}
			</PageHeader>
			{showRaw ? (
				inspect.isLoading ? (
					<SectionNote className="py-0">Reading the node…</SectionNote>
				) : (
					<CodeWell>{JSON.stringify(inspect.data ?? node, null, 2)}</CodeWell>
				)
			) : null}
			<div className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
				<div className="flex flex-col gap-8">
					<Section title="Node" icon={ServerIcon}>
						<DetailRows
							labelWidth="w-32"
							rows={[
								{
									label: "Status",
									value: (
										<StatusText
											tone={status.tone}
											label={`${status.label} · ${node.availability.toLowerCase() === "drain" ? "Drained" : capitalize(node.availability)}`}
										/>
									),
								},
								{
									label: "Role",
									value: note ? `${role} · ${note}` : role,
								},
								{
									label: "Node ID",
									value: (
										<span className="font-mono text-[13px]">
											{node.id.slice(0, 12)}
										</span>
									),
								},
								{
									label: "Address",
									value: (
										<span className="font-mono text-[13px]">
											{node.addr ?? "—"}
										</span>
									),
								},
								{
									label: "Platform",
									value: (
										<span className="font-mono text-[13px]">
											{os}/{node.architecture} · {node.engineVersion}
										</span>
									),
								},
								{
									label: "Resources",
									value: `${formatCpus(node.nanoCpus)} · ${formatMemory(node.memoryBytes)}`,
								},
							]}
						/>
					</Section>
					<Section
						title="Labels"
						icon={TagIcon}
						hint={labels.length || undefined}
					>
						{inspect.isLoading ? (
							<SectionNote>Reading labels…</SectionNote>
						) : labels.length ? (
							<div className="flex flex-wrap gap-2 py-3">
								{labels.map(([key, value]) => (
									<span
										key={key}
										className="rounded-md bg-muted px-2 py-0.5 font-mono text-[13px]"
									>
										{key}={value}
									</span>
								))}
							</div>
						) : (
							<SectionNote>No labels.</SectionNote>
						)}
						<FootNote>
							Use labels in a service's placement constraints, e.g.{" "}
							<code className="font-mono text-[13px]">
								node.labels.tier==web
							</code>
							.
						</FootNote>
					</Section>
				</div>
				<Section title="Tasks on this node" icon={BoxIcon} hint={tasks.length}>
					{tasks.length ? (
						<ResourceTable
							className="pt-4"
							headers={
								<>
									<Th>Task</Th>
									<Th className="w-32">State</Th>
									<Th className="w-36">Since</Th>
								</>
							}
						>
							{tasks.map((task) => {
								const { state, since } = splitState(task.CurrentState);
								const running = isRunning(state);
								const failed = /failed|rejected/i.test(state);
								return (
									<TableRow key={task.ID}>
										<TableCell className="w-full max-w-0 font-mono text-[13px]">
											<div className="truncate" title={task.Name}>
												{task.Name}
											</div>
											{task.Error ? (
												<div className="truncate font-sans text-destructive text-xs">
													{task.Error}
												</div>
											) : null}
										</TableCell>
										<TableCell>
											<StatusText
												tone={
													running
														? "success"
														: failed
															? "destructive"
															: "secondary"
												}
												label={state}
											/>
										</TableCell>
										<TableCell className="whitespace-nowrap text-muted-foreground">
											{since || "—"}
										</TableCell>
									</TableRow>
								);
							})}
						</ResourceTable>
					) : (
						<SectionNote>No tasks scheduled on this node.</SectionNote>
					)}
				</Section>
			</div>
			<ConfirmDialog
				open={removeOpen}
				onOpenChange={setRemoveOpen}
				title={`Remove ${node.hostname} from the swarm?`}
				description="Its tasks move to other nodes. The machine itself keeps running."
				confirmLabel="Remove"
				onConfirm={async () => {
					await waitForJob(
						await runDocker({
							serverId: hostId(ref.serverId),
							action: { type: "nodeRemove", nodeId: node.id },
						}),
					);
					toast.success("Node removed");
					nodes.refresh();
					router.push(listHref);
				}}
			/>
		</div>
	);
}
