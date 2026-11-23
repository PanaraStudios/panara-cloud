"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import {
	NetworkIcon,
	PlusIcon,
	RefreshCwIcon,
	SearchCodeIcon,
	Trash2Icon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { NetworkCreateForm } from "@/components/dashboard/networks/handle-network";
import { SyncNetworks } from "@/components/dashboard/networks/sync-networks";
import {
	asNetworkId,
	asServerId,
	useNetworks,
} from "@/components/dashboard/networks/use-networks";
import {
	DockerMark,
	MarkTile,
	networkDriverIcon,
	PanelMark,
	TypeLabel,
} from "@/components/icons/server-icons";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	ConfirmDialog,
	EmptyState,
	MoreMenu,
	PageHeader,
	ResourceTable,
	Th,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { useQueryResult, useSnapshot } from "@/lib/host-data";
import { serverUrl } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { ListSkeleton, LoadFailed, SearchField } from "./server-ui";
import { useServerRef } from "./use-server";
import { InspectJsonDialog } from "./volumes-inspect-dialog";

type DockerNetwork = {
	id: string;
	name: string;
	driver: string;
	scope?: string;
	internal: boolean;
	attachable: boolean;
	subnets: string[];
};

type Row = {
	key: string;
	name: string;
	driver: string;
	scope: string;
	subnets: string[];
	description: string;
	tone?: "destructive" | "muted";
	builtIn: boolean;
	networkId?: string;
	missing?: boolean;
};

const DOCKER_BUILT_INS = new Set([
	"bridge",
	"host",
	"none",
	"ingress",
	"docker_gwbridge",
]);

const PANEL_NETWORK = "panara-cloud-network";

const describeManaged = (network: { internal: boolean; attachable: boolean }) =>
	[
		"Custom",
		network.attachable ? "attachable" : null,
		network.internal ? "no internet" : null,
	]
		.filter(Boolean)
		.join(" · ");

const NotAvailable = () => (
	<EmptyState
		icon={NetworkIcon}
		title="Not available"
		description="Your role doesn't include this part of the server."
	/>
);

export function ServerNetworksView() {
	const permissions = usePermissions();
	if (!permissions.docker.read) return <NotAvailable />;
	return <NetworksTable />;
}

function NetworksTable() {
	const ref = useServerRef();
	const { active } = useOrganization();
	const networks = useNetworks(ref.serverId);
	const [showBuiltIns, setShowBuiltIns] = useState(true);
	const [query, setQuery] = useState("");
	const [removing, setRemoving] = useState<Row | null>(null);
	const [inspecting, setInspecting] = useState<string | null>(null);
	const snapshot = useSnapshot<DockerNetwork[]>(ref.serverId, "networks");
	const sync = useQueryResult(api.infra.networks.toSync, {
		organizationId: active.id,
		serverId: asServerId(ref.serverId),
	});
	const removeNetwork = useMutation(api.infra.networks.remove);
	const recreateNetwork = useMutation(api.infra.networks.recreate);

	const rows = useMemo(() => {
		const missing = new Set(
			sync instanceof Error || !sync
				? []
				: sync.missing.map((item) => item.networkId as string),
		);
		const managed: Row[] = (networks ?? []).map((network) => {
			const isMissing = missing.has(network.networkId);
			return {
				key: network.networkId,
				name: network.name,
				driver: network.driver,
				scope: network.driver === "overlay" ? "swarm" : "local",
				subnets: (network.ipam?.config ?? []).flatMap((config) =>
					config.subnet ? [config.subnet] : [],
				),
				description:
					network.status === "error"
						? (network.error ?? "Docker couldn't create it")
						: network.status === "pending"
							? "Creating…"
							: isMissing
								? "Missing in Docker"
								: describeManaged(network),
				tone:
					network.status === "error" || isMissing ? "destructive" : undefined,
				builtIn: false,
				networkId: network.networkId,
				missing: isMissing,
			};
		});
		const names = new Set(managed.map((row) => row.name));
		const docker: Row[] = showBuiltIns
			? (snapshot.data ?? [])
					.filter((network) => !names.has(network.name))
					.map((network) => ({
						key: `docker:${network.id}`,
						name: network.name,
						driver: network.driver,
						scope:
							network.scope ??
							(network.driver === "overlay" ? "swarm" : "local"),
						subnets: network.subnets,
						description:
							network.name === PANEL_NETWORK
								? "Default for every service · Traefik routes through it"
								: DOCKER_BUILT_INS.has(network.name)
									? `Docker built-in${network.name === "ingress" ? " · swarm routing mesh" : ""}`
									: network.name.endsWith("_default")
										? "Created by a compose stack"
										: "Not managed by Panara Cloud",
						tone: network.name === PANEL_NETWORK ? undefined : "muted",
						builtIn: true,
					}))
			: [];
		const panel = docker.filter((row) => row.name === PANEL_NETWORK);
		return [
			...panel,
			...managed,
			...docker.filter((row) => row.name !== PANEL_NETWORK),
		];
	}, [networks, snapshot.data, showBuiltIns, sync]);

	const needle = query.trim().toLowerCase();
	const visible = rows.filter(
		(row) =>
			!needle ||
			row.name.toLowerCase().includes(needle) ||
			row.subnets.some((subnet) => subnet.includes(needle)),
	);

	const createUrl = serverUrl(ref.routeId, "networks/new");
	const failed = rows.length === 0 && !!snapshot.error;

	return (
		<div className="flex w-full flex-col gap-6 pb-10">
			{failed ? null : (
				<div className="flex flex-wrap items-center gap-2">
					<SearchField
						value={query}
						onChange={setQuery}
						placeholder="Search networks…"
					/>
					<div className="ml-auto flex flex-wrap items-center gap-2">
						<Switch
							id="show-docker-built-ins"
							checked={showBuiltIns}
							onCheckedChange={setShowBuiltIns}
						/>
						<Label htmlFor="show-docker-built-ins" className="mr-2 font-normal">
							Show Docker built-ins
						</Label>
						<SyncNetworks serverId={ref.serverId} />
						<Button nativeButton={false} render={<Link href={createUrl} />}>
							<PlusIcon data-icon="inline-start" />
							Create network
						</Button>
					</div>
				</div>
			)}
			{networks === undefined ? (
				<ListSkeleton />
			) : failed ? (
				<LoadFailed
					icon={NetworkIcon}
					what="networks"
					error={snapshot.error ?? ""}
					onRetry={() => void snapshot.refresh()}
					retrying={snapshot.isRefreshing}
				/>
			) : rows.length === 0 ? (
				<EmptyState
					icon={NetworkIcon}
					title="No networks yet"
					description="Create a Docker network to put services on their own private network."
				>
					<Button
						variant="outline"
						size="sm"
						nativeButton={false}
						render={<Link href={createUrl} />}
					>
						Create network
					</Button>
				</EmptyState>
			) : (
				<ResourceTable
					headers={
						<>
							<Th>Network</Th>
							<Th>Driver</Th>
							<Th>Scope</Th>
							<Th>Subnet</Th>
							<Th className="w-10" />
						</>
					}
				>
					{visible.length === 0 ? (
						<TableRow>
							<TableCell
								colSpan={5}
								className="h-20 text-center text-muted-foreground"
							>
								No networks match.
							</TableCell>
						</TableRow>
					) : null}
					{visible.map((row) => {
						const dim = row.tone === "muted";
						return (
							<TableRow key={row.key}>
								<TableCell className="max-w-[28rem]">
									<div className="flex min-w-0 items-center gap-2.5">
										<MarkTile
											icon={
												row.name === PANEL_NETWORK
													? PanelMark
													: row.builtIn && DOCKER_BUILT_INS.has(row.name)
														? DockerMark
														: NetworkIcon
											}
											muted={dim}
										/>
										<div className="flex min-w-0 flex-col gap-0.5">
											<span
												className={cn(
													"truncate font-medium font-mono text-[13px]",
													dim && "text-muted-foreground",
												)}
											>
												{row.name}
											</span>
											<span
												className={cn(
													"truncate text-xs",
													row.tone === "destructive"
														? "text-destructive"
														: "text-muted-foreground",
												)}
											>
												{row.description}
											</span>
										</div>
									</div>
								</TableCell>
								<TableCell className="font-mono text-[13px] text-muted-foreground">
									<TypeLabel icon={networkDriverIcon(row.driver)}>
										{row.driver}
									</TypeLabel>
								</TableCell>
								<TableCell className={cn(dim && "text-muted-foreground")}>
									{row.scope}
								</TableCell>
								<TableCell
									className={cn(
										"font-mono text-[13px]",
										dim && "text-muted-foreground",
									)}
								>
									{row.subnets.length ? row.subnets.join(", ") : "—"}
								</TableCell>
								<TableCell>
									<div className="flex justify-end">
										<MoreMenu>
											<DropdownMenuItem onClick={() => setInspecting(row.name)}>
												<SearchCodeIcon />
												Inspect
											</DropdownMenuItem>
											{row.missing && row.networkId ? (
												<DropdownMenuItem
													onClick={async () => {
														try {
															await recreateNetwork({
																networkId: asNetworkId(row.networkId ?? ""),
															});
															toast.success(`Recreating ${row.name}`);
															await snapshot.refresh();
														} catch (error) {
															toast.error(errorMessage(error));
														}
													}}
												>
													<RefreshCwIcon />
													Recreate in Docker
												</DropdownMenuItem>
											) : null}
											{row.networkId ? (
												<DropdownMenuItem
													variant="destructive"
													onClick={() => setRemoving(row)}
												>
													<Trash2Icon />
													Delete
												</DropdownMenuItem>
											) : null}
										</MoreMenu>
									</div>
								</TableCell>
							</TableRow>
						);
					})}
				</ResourceTable>
			)}
			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(open) => !open && setRemoving(null)}
				title="Delete network?"
				description={`“${removing?.name}” will be removed from Docker and Panara Cloud. Services attached to it lose that network on their next deploy.`}
				onConfirm={async () => {
					if (!removing?.networkId) return;
					await removeNetwork({ networkId: asNetworkId(removing.networkId) });
					toast.success("Network deleted");
				}}
			/>
			<InspectJsonDialog
				serverId={ref.serverId}
				title="Inspect network"
				action={
					inspecting ? { type: "networkInspect", name: inspecting } : null
				}
				onClose={() => setInspecting(null)}
			/>
		</div>
	);
}

export function NewNetworkPage() {
	const ref = useServerRef();
	const router = useRouter();
	const permissions = usePermissions();
	if (!permissions.docker.read) return <NotAvailable />;
	const back = () => router.push(serverUrl(ref.routeId, "networks"));
	return (
		<div className="flex w-full flex-col gap-6 pb-10">
			<PageHeader
				title="Create network"
				description="A network can't be changed once it exists: to change one, delete it and create it again."
			/>
			<NetworkCreateForm serverId={ref.serverId} onDone={back} inline />
		</div>
	);
}
