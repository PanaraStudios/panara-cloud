"use client";

import { api } from "@panara-cloud/backend/api";
import type { Doc, Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import {
	ArrowUpRightIcon,
	HammerIcon,
	PlusIcon,
	PowerIcon,
	PowerOffIcon,
	RocketIcon,
	ServerIcon,
	SlidersHorizontalIcon,
	SquareTerminalIcon,
	Trash2Icon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DeleteServerModal } from "@/components/dashboard/settings/servers/delete-server-modal";
import {
	MarkTile,
	PanelMark,
	TypeLabel,
} from "@/components/icons/server-icons";
import { Button } from "@/components/ui/button";
import {
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	AccessDeniedState,
	EmptyState,
	MoreMenu,
	PageHeader,
	ResourceTable,
	Th,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { LOCAL_SERVER_ID, serverUrl } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { useRouter } from "@/lib/router";
import Link from "@/lib/router/link";
import { cn } from "@/lib/utils";
import {
	FilterPills,
	ListSkeleton,
	SearchField,
	StatusText,
} from "./server-ui";
import { LOCAL_SERVER_NAME, serverStatus } from "./use-server";

type Filter = "all" | "deploy" | "build" | "attention";

function ServicesCount({ serverId }: { serverId: Id<"servers"> }) {
	const canRead = usePermissions().server.read;
	const services = useQuery(
		api.servers.services,
		canRead ? { serverId } : "skip",
	);
	if (!canRead) return <span className="text-muted-foreground">—</span>;
	if (services === undefined)
		return <span className="text-muted-foreground">…</span>;
	return services.length === 0 ? (
		<span className="text-muted-foreground">—</span>
	) : (
		<span className="tabular-nums">{services.length}</span>
	);
}

export function ServersList() {
	const router = useRouter();
	const { active } = useOrganization();
	const permissions = usePermissions();
	const servers = useQuery(api.servers.list, { organizationId: active.id });
	const isInstanceAdmin = useQuery(api.infra.webServer.isInstanceAdmin, {});
	const web = useQuery(api.infra.webServer.get, isInstanceAdmin ? {} : "skip");
	const setStatus = useMutation(api.servers.setStatus);
	const runSetup = useMutation(api.infra.setup.run);
	const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(
		null,
	);
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<Filter>("all");

	const rows = useMemo(
		() =>
			(servers ?? []).map((server) => ({
				server,
				status: serverStatus(server),
			})),
		[servers],
	);
	const attention = rows.filter(
		(row) =>
			row.status.label === "Needs attention" ||
			row.status.label === "Unreachable",
	).length;
	const total = rows.length + (isInstanceAdmin ? 1 : 0);
	const deployCount =
		rows.filter((row) => row.server.serverType === "deploy").length +
		(isInstanceAdmin ? 1 : 0);
	const buildCount = rows.filter(
		(row) => row.server.serverType === "build",
	).length;

	const needle = query.trim().toLowerCase();
	const matches = (name: string, ip: string | undefined) =>
		!needle ||
		name.toLowerCase().includes(needle) ||
		(ip ?? "").toLowerCase().includes(needle);
	const visible = rows.filter(({ server, status }) => {
		if (!matches(server.name, server.ipAddress)) return false;
		if (filter === "deploy") return server.serverType === "deploy";
		if (filter === "build") return server.serverType === "build";
		if (filter === "attention")
			return (
				status.label === "Needs attention" || status.label === "Unreachable"
			);
		return true;
	});
	const showLocal =
		!!isInstanceAdmin &&
		(filter === "all" || filter === "deploy") &&
		matches(LOCAL_SERVER_NAME, web?.serverIp ?? undefined);

	const toggleStatus = (serverId: Id<"servers">, activate: boolean) =>
		setStatus({ serverId, serverStatus: activate ? "active" : "inactive" })
			.then(() =>
				toast.success(activate ? "Server activated" : "Server deactivated"),
			)
			.catch((error) => toast.error(errorMessage(error)));

	const startSetup = (server: Doc<"servers">) =>
		runSetup({ serverId: server._id })
			.then(() => router.push(serverUrl(server._id)))
			.catch((error) => toast.error(errorMessage(error)));

	// The instance administrator keeps the panel host in an organization
	// where they are a plain member.
	if (!permissions.server.read && isInstanceAdmin === false) {
		return <AccessDeniedState what="servers" />;
	}

	const loading = servers === undefined || isInstanceAdmin === undefined;
	const noRemote = !loading && rows.length === 0;

	return (
		<div className="flex w-full flex-col gap-6">
			<PageHeader
				title="Servers"
				description="Machines Panara Cloud deploys to. The panel host is one of them."
			>
				{permissions.server.create ? (
					<Button nativeButton={false} render={<Link href="/servers/new" />}>
						<PlusIcon data-icon="inline-start" />
						Add server
					</Button>
				) : null}
			</PageHeader>
			{loading ? (
				<ListSkeleton rows={3} />
			) : (
				<>
					{rows.length > 0 ? (
						<div className="flex flex-wrap items-center gap-2">
							<SearchField
								value={query}
								onChange={setQuery}
								placeholder="Search servers or IPs…"
							/>
							<FilterPills
								value={filter}
								onValueChange={setFilter}
								options={[
									{ value: "all", label: "All", count: total },
									{ value: "deploy", label: "Deploy", count: deployCount },
									...(buildCount > 0
										? [
												{
													value: "build" as const,
													label: "Build",
													count: buildCount,
												},
											]
										: []),
									...(attention > 0
										? [
												{
													value: "attention" as const,
													label: "Needs attention",
													count: attention,
													tone: "warning" as const,
												},
											]
										: []),
								]}
							/>
						</div>
					) : null}
					{showLocal || visible.length > 0 ? (
						<ResourceTable
							headers={
								<>
									<Th>Server</Th>
									<Th>Status</Th>
									<Th>Type</Th>
									<Th>Services</Th>
									<Th className="w-10" />
								</>
							}
						>
							{showLocal ? (
								<TableRow
									className="cursor-pointer"
									onClick={() => router.push(serverUrl(LOCAL_SERVER_ID))}
								>
									<TableCell>
										<div className="flex min-w-0 items-center gap-2.5">
											<MarkTile icon={PanelMark} />
											<div className="flex min-w-0 flex-col">
												<span className="flex items-center gap-2">
													<Link
														href={serverUrl(LOCAL_SERVER_ID)}
														className="font-medium hover:underline"
														onClick={(event) => event.stopPropagation()}
													>
														{LOCAL_SERVER_NAME}
													</Link>
													<span className="text-muted-foreground text-xs">
														Panel host
													</span>
												</span>
												{web?.serverIp ? (
													<span className="font-mono text-[13px] text-muted-foreground">
														{web.serverIp}
													</span>
												) : null}
											</div>
										</div>
									</TableCell>
									<TableCell>
										<StatusText tone="success" label="Ready" />
									</TableCell>
									<TableCell>
										<TypeLabel icon={RocketIcon}>Deploy</TypeLabel>
									</TableCell>
									<TableCell className="text-muted-foreground">—</TableCell>
									<TableCell
										className="text-right"
										onClick={(event) => event.stopPropagation()}
									>
										<MoreMenu>
											<DropdownMenuItem
												nativeButton={false}
												render={<Link href={serverUrl(LOCAL_SERVER_ID)} />}
											>
												<ArrowUpRightIcon />
												Open
											</DropdownMenuItem>
											{permissions.server.terminal ? (
												<DropdownMenuItem
													nativeButton={false}
													render={
														<Link
															href={serverUrl(LOCAL_SERVER_ID, "terminal")}
														/>
													}
												>
													<SquareTerminalIcon />
													Terminal
												</DropdownMenuItem>
											) : null}
										</MoreMenu>
									</TableCell>
								</TableRow>
							) : null}
							{visible.map(({ server, status }) => {
								const href = serverUrl(server._id);
								const inactive = server.serverStatus === "inactive";
								const notSetUp =
									status.label === "Not set up" ||
									status.label === "No SSH key";
								return (
									<TableRow
										key={server._id}
										className="cursor-pointer"
										onClick={() => router.push(href)}
									>
										<TableCell>
											<div className="flex min-w-0 items-center gap-2.5">
												<MarkTile icon={ServerIcon} muted={inactive} />
												<div className="flex min-w-0 flex-col">
													<Link
														href={href}
														className={cn(
															"w-fit font-medium hover:underline",
															inactive && "text-muted-foreground",
														)}
														onClick={(event) => event.stopPropagation()}
													>
														{server.name}
													</Link>
													<span className="font-mono text-[13px] text-muted-foreground">
														{server.ipAddress}
														{server.port !== 22 ? `:${server.port}` : ""}
													</span>
												</div>
											</div>
										</TableCell>
										<TableCell>
											<div className="flex flex-col gap-0.5">
												<StatusText
													tone={status.tone}
													label={status.label}
													hollow={notSetUp}
												/>
												{status.note ? (
													<span className="max-w-64 truncate pl-3.5 text-muted-foreground text-xs">
														{status.note}
													</span>
												) : null}
											</div>
										</TableCell>
										<TableCell
											className={cn(inactive && "text-muted-foreground")}
										>
											<TypeLabel
												icon={
													server.serverType === "build"
														? HammerIcon
														: RocketIcon
												}
											>
												{server.serverType === "build" ? "Build" : "Deploy"}
											</TypeLabel>
										</TableCell>
										<TableCell>
											{inactive ? (
												<span className="text-muted-foreground">
													Deactivated
												</span>
											) : (
												<ServicesCount serverId={server._id} />
											)}
										</TableCell>
										<TableCell onClick={(event) => event.stopPropagation()}>
											<div className="flex items-center justify-end gap-2">
												{notSetUp &&
												!inactive &&
												server.sshKeyId &&
												permissions.server.create ? (
													<Button
														size="sm"
														variant="outline"
														onClick={() => startSetup(server)}
													>
														Run setup
													</Button>
												) : null}
												<MoreMenu>
													<DropdownMenuItem
														nativeButton={false}
														render={<Link href={href} />}
													>
														<ArrowUpRightIcon />
														Open
													</DropdownMenuItem>
													{permissions.server.terminal && server.sshKeyId ? (
														<DropdownMenuItem
															nativeButton={false}
															render={
																<Link
																	href={serverUrl(server._id, "terminal")}
																/>
															}
														>
															<SquareTerminalIcon />
															Terminal
														</DropdownMenuItem>
													) : null}
													{permissions.server.create ? (
														<DropdownMenuItem
															nativeButton={false}
															render={
																<Link
																	href={serverUrl(server._id, "settings")}
																/>
															}
														>
															<SlidersHorizontalIcon />
															Settings
														</DropdownMenuItem>
													) : null}
													{permissions.server.create ? (
														<DropdownMenuItem
															onClick={() => toggleStatus(server._id, inactive)}
														>
															{inactive ? <PowerIcon /> : <PowerOffIcon />}
															{inactive ? "Activate" : "Deactivate"}
														</DropdownMenuItem>
													) : null}
													{permissions.server.delete ? (
														<>
															<DropdownMenuSeparator />
															<DropdownMenuItem
																variant="destructive"
																onClick={() =>
																	setDeleting({
																		id: server._id,
																		name: server.name,
																	})
																}
															>
																<Trash2Icon />
																Delete
															</DropdownMenuItem>
														</>
													) : null}
												</MoreMenu>
											</div>
										</TableCell>
									</TableRow>
								);
							})}
						</ResourceTable>
					) : rows.length > 0 ? (
						<p className="py-3 text-muted-foreground text-sm">
							No servers match.
						</p>
					) : null}
					{noRemote ? (
						<EmptyState
							icon={ServerIcon}
							title={
								isInstanceAdmin ? "No remote servers yet" : "No servers yet"
							}
							description={
								isInstanceAdmin
									? "Everything runs on the panel host for now. Add a server to spread services out, or a build server so builds stop slowing down your apps."
									: "Add a server over SSH to deploy your applications on it."
							}
						>
							{permissions.server.create ? (
								<Button
									variant="outline"
									size="sm"
									nativeButton={false}
									render={<Link href="/servers/new" />}
								>
									Add server
								</Button>
							) : null}
						</EmptyState>
					) : null}
				</>
			)}
			{deleting ? (
				<DeleteServerModal
					key={deleting.id}
					serverId={deleting.id}
					serverName={deleting.name}
					open
					onOpenChange={(open) => {
						if (!open) setDeleting(null);
					}}
				/>
			) : null}
		</div>
	);
}
