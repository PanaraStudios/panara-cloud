"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import {
	BlocksIcon,
	BoxIcon,
	BracesIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CopyIcon,
	EyeIcon,
	EyeOffIcon,
	NetworkIcon,
	PlusIcon,
	ServerIcon,
	TagIcon,
	TriangleAlertIcon,
	UnplugIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
	hostId,
	useWaitForJob,
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
	BackLink,
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
import { maskToken, SWARM_PORTS } from "@/lib/cluster";
import { useDockerInspectQuery } from "@/lib/host-data";
import { serverUrl } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { useJoinInfo } from "./cluster-data";
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

const LINK = "text-foreground underline underline-offset-2";

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
	if (nodes?.length === 1) return nodes[0];
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

export function ServerClusterPage() {
	return (
		<Allowed>
			<ClusterOverview />
		</Allowed>
	);
}

/** Registries a node can pull from; undefined while loading. Adding a node
    without one is pointless: the other machines could not get the image. */
function useRegistryNames(enabled: boolean) {
	const { active } = useOrganization();
	return useQuery(
		api.sources.registries.listNames,
		enabled ? { organizationId: active.id } : "skip",
	)?.map((registry) => registry.registryName);
}

/** The one way into the Add node page. Without a registry it stays in
    place, disabled, and says why. */
function AddNodeButton({ registries }: { registries: string[] | undefined }) {
	const ref = useServerRef();
	if (!registries?.length) {
		return (
			<Button
				disabled={!registries}
				disabledReason={registries ? "Add a registry first" : null}
			>
				<PlusIcon data-icon="inline-start" />
				Add node
			</Button>
		);
	}
	return (
		<Button
			nativeButton={false}
			render={<Link href={serverUrl(ref.routeId, "cluster/new")} />}
		>
			<PlusIcon data-icon="inline-start" />
			Add node
		</Button>
	);
}

function ClusterOverview() {
	const ref = useServerRef();
	const permissions = usePermissions();
	const canAdd = permissions.server.create;
	const nodes = useSwarmNodes(ref.serverId);
	const services = useSwarmServices(ref.serverId);
	const registries = useRegistryNames(canAdd);
	const self = useSelfNode(nodes.raw);
	const list = nodes.raw ?? [];
	const alone = list.length <= 1;

	return (
		<div className="flex w-full flex-col gap-6 pb-10">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
				<p className="max-w-3xl text-muted-foreground text-sm">
					A cluster joins several machines with Docker Swarm, so one application
					can run its replicas on all of them and keep serving when one stops.
					To add a separate machine that you deploy services to, use{" "}
					{canAdd ? (
						<Link href="/servers/new" className={LINK}>
							Add server
						</Link>
					) : (
						"Add server"
					)}
					.
				</p>
				{canAdd && nodes.raw && !alone ? (
					<AddNodeButton registries={registries} />
				) : null}
			</div>
			{nodes.isLoading ? (
				<ListSkeleton rows={3} />
			) : nodes.error && !/^Docker Swarm is /.test(nodes.error) ? (
				<LoadFailed
					icon={BlocksIcon}
					what="cluster nodes"
					error={nodes.error}
					onRetry={() => void nodes.refresh()}
				/>
			) : !nodes.raw ? (
				<EmptyState
					icon={BlocksIcon}
					title="No cluster on this server"
					description={
						nodes.error
							? `${nodes.error}. Setup initializes it.`
							: "Docker Swarm isn't active on this server. Setup initializes it."
					}
				/>
			) : alone ? (
				<EmptyState
					wide
					icon={BlocksIcon}
					title="One machine so far"
					description={`${ref.name ?? "This server"} is the only machine in its cluster, so everything on it runs here. Add a node when an application should run on more than one machine.`}
				>
					{canAdd ? (
						<>
							<Needs registries={registries} />
							<div className="pt-1">
								<AddNodeButton registries={registries} />
							</div>
						</>
					) : null}
				</EmptyState>
			) : (
				<>
					<StatStrip>
						<ClusterStats nodes={list} tasks={services.tasks} />
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
										`cluster/${encodeURIComponent(node.id)}`,
									)}
								/>
							))}
						</ResourceTable>
						{canAdd && registries?.length === 0 ? (
							<FootNote className="pt-3">
								No registry is connected, so the other nodes cannot pull an
								application's image.{" "}
								<Link href="/settings/registries/new" className={LINK}>
									Add a registry
								</Link>
							</FootNote>
						) : null}
					</Section>
				</>
			)}
			{canAdd && nodes.raw ? <JoinManually serverId={ref.serverId} /> : null}
		</div>
	);
}

/** What a second machine needs before Add node can work, each with where
    it stands. */
function Needs({ registries }: { registries: string[] | undefined }) {
	const first = registries?.[0];
	const more = (registries?.length ?? 1) - 1;
	return (
		<ul className="flex flex-col gap-2 py-1 text-left text-sm text-wrap">
			<li className="flex items-start gap-2.5">
				{registries?.length === 0 ? (
					<TriangleAlertIcon
						aria-hidden="true"
						className="mt-0.5 size-4 shrink-0 text-warning"
					/>
				) : (
					<CheckIcon
						aria-hidden="true"
						className={cn(
							"mt-0.5 size-4 shrink-0",
							first ? "text-success" : "text-muted-foreground",
						)}
					/>
				)}
				<span className="min-w-0">
					A registry the nodes pull images from
					{first ? (
						<span className="text-muted-foreground">
							{" · "}
							{first}
							{more > 0 ? ` and ${more} more` : ""}
						</span>
					) : null}
					{registries?.length === 0 ? (
						<>
							{": "}
							<Link href="/settings/registries/new" className={LINK}>
								Add a registry
							</Link>
						</>
					) : null}
				</span>
			</li>
			<li className="flex items-start gap-2.5">
				<NetworkIcon
					aria-hidden="true"
					className="mt-0.5 size-4 shrink-0 text-muted-foreground"
				/>
				<span className="min-w-0">
					Ports open between the two machines:{" "}
					<span className="whitespace-nowrap font-mono text-[13px]">
						{SWARM_PORTS}
					</span>
				</span>
			</li>
		</ul>
	);
}

function ClusterStats({
	nodes,
	tasks,
}: {
	nodes: SwarmNode[];
	tasks: SwarmTask[] | undefined;
}) {
	const managers = nodes.filter((node) => node.role === "manager").length;
	const workers = nodes.length - managers;
	const desired = (tasks ?? []).filter((task) => isRunning(task.DesiredState));
	const running = desired.filter((task) => isRunning(task.CurrentState));
	return (
		<>
			<Stat
				label="Nodes"
				value={nodes.length}
				detail={`${managers} ${managers === 1 ? "manager" : "managers"} · ${workers} ${workers === 1 ? "worker" : "workers"}`}
			/>
			<Stat
				label="Tasks"
				value={running.length}
				detail={`running of ${desired.length} desired`}
			/>
		</>
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

/** The raw `docker swarm join` commands, for someone who would rather not
    be walked through it: closed until asked for, and the tokens are read
    from the server only then. */
function JoinManually({ serverId }: { serverId: string | undefined }) {
	const [open, setOpen] = useState(false);
	const join = useJoinInfo(serverId, open);
	const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
	return (
		<section className="flex min-w-0 flex-col">
			<h2 className="font-semibold text-[15px]">
				<button
					type="button"
					aria-expanded={open}
					aria-controls="join-manually"
					onClick={() => setOpen((value) => !value)}
					className="flex min-h-10 w-full items-center gap-2 rounded-sm border-border border-b pb-2 text-left outline-none focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
				>
					<Chevron
						aria-hidden="true"
						className="size-4 shrink-0 text-muted-foreground"
					/>
					<span className="shrink-0">Join manually</span>
					<span className="truncate font-normal text-muted-foreground text-sm">
						The raw join commands, for a machine that already has Docker
					</span>
				</button>
			</h2>
			{open ? (
				<div id="join-manually">
					{join.isLoading ? (
						<SectionNote>Reading the join commands…</SectionNote>
					) : join.error || !join.info ? (
						<FailureNote
							error={join.error ?? "No answer"}
							what="the join commands"
						/>
					) : (
						<>
							<TokenRow label="Worker" command={join.info.worker} />
							<TokenRow label="Manager" command={join.info.manager} />
						</>
					)}
					<FootNote className="pt-3">
						A join token is a secret: whoever has one can join this cluster.
						Both machines must reach each other on{" "}
						<span className="whitespace-nowrap font-mono text-[13px]">
							{SWARM_PORTS}
						</span>
						.
					</FootNote>
				</div>
			) : null}
		</section>
	);
}

function TokenRow({ label, command }: { label: string; command: string }) {
	const [revealed, setRevealed] = useState(false);
	return (
		<div className="flex min-h-11 items-center gap-4 border-border border-b py-2 text-sm">
			<span className="w-24 shrink-0 text-muted-foreground">{label}</span>
			<code
				className={cn(
					"min-w-0 flex-1 font-mono text-[13px]",
					revealed ? "break-all" : "truncate",
				)}
			>
				{revealed ? command : maskToken(command)}
			</code>
			<div className="flex shrink-0 items-center gap-1">
				<Button
					variant="ghost"
					size="sm"
					aria-pressed={revealed}
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

export function ClusterNodePage({ nodeId }: { nodeId: string }) {
	return (
		<Allowed>
			<ClusterNode nodeId={nodeId} />
		</Allowed>
	);
}

function ClusterNode({ nodeId }: { nodeId: string }) {
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
	const listHref = serverUrl(ref.routeId, "cluster");

	if (nodes.isLoading) return <ListSkeleton rows={3} />;
	if (!node) {
		return (
			<EmptyState
				icon={BlocksIcon}
				title="Node not found"
				description="It may have left the cluster."
			>
				<Button
					variant="outline"
					nativeButton={false}
					render={<Link href={listHref} />}
				>
					Back to Cluster
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
			<BackLink href={listHref} label="Cluster" className="-mb-6" />
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
							Remove from cluster
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
				title={`Remove ${node.hostname} from the cluster?`}
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
