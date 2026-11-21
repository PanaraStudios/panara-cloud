"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useConvexAuth, useQuery } from "convex/react";
import {
	BoxIcon,
	FolderIcon,
	PlayIcon,
	PlusIcon,
	RocketIcon,
	SettingsIcon,
	SquareIcon,
	Trash2Icon,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { DuplicateProject } from "@/components/dashboard/project/duplicate-project";
import { MarkTile } from "@/components/icons/service-icons";
import { ServiceIcon } from "@/components/service/service-icon";
import { Toolbar, ToolbarSearch } from "@/components/shared/list-toolbar";
import { Segmented } from "@/components/shared/segmented";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	ConfirmDialog,
	EmptyState,
	MoreMenu,
	NotFoundState,
	ResourceTable,
	SelectionBar,
	Th,
	useListSearch,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import {
	isDatabaseKind,
	SERVICE_KIND_LABELS,
	serviceTarget,
} from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { MoveServicesDialog } from "./move-services-dialog";
import { ServiceStatusLabel } from "./service-status";
import { TimeAgo } from "./time-ago";
import {
	type ServiceAction,
	type ServiceRow,
	useServiceActions,
} from "./use-service-actions";

const PANEL_SERVER = "panel";
const KIND_FILTERS = [
	{ value: "application", label: "Applications" },
	{ value: "compose", label: "Compose" },
	{ value: "database", label: "Databases" },
];
const MAX_PENDING_TARGETS = 50;

/** `/projects/[p]/environment/[e]`: the environment's services as a table. */
export function EnvironmentServices() {
	const { projectId, environmentId } = useParams<{
		projectId: string;
		environmentId: string;
	}>();
	const router = useRouter();
	const permissions = usePermissions();
	const { active } = useOrganization();
	const { isAuthenticated } = useConvexAuth();
	const environment = useQuery(api.environments.get, {
		environmentId: environmentId as Id<"environments">,
	});
	const services = useQuery(api.environments.services, {
		environmentId: environmentId as Id<"environments">,
	});
	const targets = useMemo(
		() =>
			(services ?? [])
				.slice(0, MAX_PENDING_TARGETS)
				.map((service) => serviceTarget(service.type, service.id)),
		[services],
	);
	const pending = useQuery(
		api.serviceEvents.pendingChangeCounts,
		isAuthenticated && targets.length > 0
			? { organizationId: active.id, targets }
			: "skip",
	);
	const actions = useServiceActions();
	const { query, setQuery, search } = useListSearch();
	const [kind, setKind] = useState("all");
	const [server, setServer] = useState("all");
	const [selected, setSelected] = useState<string[]>([]);
	const [moving, setMoving] = useState(false);
	const [deleting, setDeleting] = useState<ServiceRow[] | null>(null);
	const [busy, setBusy] = useState(false);

	const pendingById = useMemo(() => {
		const map = new Map<string, number>();
		targets.forEach((target, index) => {
			const count = pending?.[index]?.pendingChangeCount;
			if (count) map.set(target.id, count);
		});
		return map;
	}, [pending, targets]);

	const servers = useMemo(() => {
		const map = new Map<string, string>();
		for (const service of services ?? []) {
			map.set(
				service.serverId ?? PANEL_SERVER,
				service.serverName ?? "Panara Cloud",
			);
		}
		return [...map.entries()];
	}, [services]);

	const rows = useMemo(() => {
		const needle = search.trim().toLowerCase();
		return (services ?? [])
			.filter(
				(service) =>
					!needle ||
					service.name.toLowerCase().includes(needle) ||
					service.appName.toLowerCase().includes(needle) ||
					service.domain?.host.toLowerCase().includes(needle),
			)
			.filter(
				(service) =>
					kind === "all" ||
					(kind === "database"
						? isDatabaseKind(service.type)
						: service.type === kind),
			)
			.filter(
				(service) =>
					server === "all" || (service.serverId ?? PANEL_SERVER) === server,
			)
			.sort(
				(a, b) =>
					(b.lastDeployDate ?? b.createdAt) - (a.lastDeployDate ?? a.createdAt),
			);
	}, [services, search, kind, server]);

	useEffect(() => {
		if (environment?.name && environment.project) {
			document.title = `${environment.project.name} · ${environment.name} | Panara Cloud`;
		}
	}, [environment]);

	if (environment === undefined || services === undefined) return null;
	if (environment === null)
		return (
			<NotFoundState
				icon={FolderIcon}
				noun="environment"
				backHref="/"
				backLabel="All projects"
			/>
		);

	const serviceUrl = (service: ServiceRow) =>
		`/projects/${projectId}/environment/${environmentId}/services/${service.type}/${service.id}`;
	const selectedRows = rows.filter((row) => selected.includes(row.id));
	const allSelected = rows.length > 0 && selectedRows.length === rows.length;

	const bulk = async (
		label: string,
		task: (service: ServiceRow) => Promise<void>,
		list: ServiceRow[] = selectedRows,
	) => {
		setBusy(true);
		let done = 0;
		for (const service of list) {
			try {
				await task(service);
				done++;
			} catch (error) {
				toast.error(errorMessage(error));
			}
		}
		setBusy(false);
		if (done > 0)
			toast.success(`${label} ${done} ${done === 1 ? "service" : "services"}`);
		setSelected([]);
	};

	const runOne = (
		service: ServiceRow & { name: string },
		action: ServiceAction,
	) =>
		toast.promise(actions.run(service, action), {
			loading: `${action === "deploy" ? "Deploying" : action === "start" ? "Starting" : "Stopping"} ${service.name}…`,
			success: `${service.name} ${action === "deploy" ? "queued for deployment" : action === "start" ? "started" : "stopped"}`,
			error: (error) => errorMessage(error),
		});

	const canManage = permissions.service.create;
	const canDeploy = permissions.deployment.create;
	const newService = (
		<Button
			nativeButton={false}
			render={
				<Link href={`/projects/${projectId}/environment/${environmentId}/new`}>
					<PlusIcon data-icon="inline-start" />
					New service
				</Link>
			}
		/>
	);

	return (
		<div className="flex w-full flex-1 flex-col gap-6">
			{services.length === 0 ? (
				<EmptyState
					icon={BoxIcon}
					title="No services yet"
					description="Deploy an application from Git or a Docker image, a database, a compose stack, or a template."
				>
					{canManage ? newService : null}
				</EmptyState>
			) : (
				<>
					<div className="flex flex-col gap-4">
						<Toolbar>
							<ToolbarSearch
								value={query}
								onChange={setQuery}
								placeholder="Search services…"
							/>
							<Segmented
								aria-label="Service type"
								value={kind}
								onValueChange={setKind}
								items={[
									{ value: "all", label: `All ${services.length}` },
									...KIND_FILTERS.filter((filter) =>
										services.some((service) =>
											filter.value === "database"
												? isDatabaseKind(service.type)
												: service.type === filter.value,
										),
									),
								]}
							/>
							{servers.length > 1 ? (
								<Select value={server} onValueChange={setServer}>
									<SelectTrigger aria-label="Server">
										<span className="text-muted-foreground">Server</span>
										<span className="font-medium">
											<SelectValue />
										</span>
									</SelectTrigger>
									<SelectContent align="start">
										<SelectItem value="all">All</SelectItem>
										{servers.map(([id, name]) => (
											<SelectItem key={id} value={id}>
												{name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							) : null}
						</Toolbar>
						<ResourceTable
							headers={
								<>
									<Th className="w-10">
										<Checkbox
											aria-label="Select all services"
											checked={allSelected}
											indeterminate={selectedRows.length > 0 && !allSelected}
											onCheckedChange={() =>
												setSelected(
													allSelected ? [] : rows.map((row) => row.id),
												)
											}
										/>
									</Th>
									<Th className="w-[32%]">Service</Th>
									<Th>Status</Th>
									<Th className="max-lg:hidden">Type</Th>
									<Th className="max-md:hidden">Domain</Th>
									<Th className="max-sm:hidden">Last deploy</Th>
									{servers.length > 1 ? (
										<Th className="max-xl:hidden">Server</Th>
									) : null}
									<Th className="w-12" />
								</>
							}
						>
							{rows.length === 0 ? (
								<TableRow>
									<TableCell
										colSpan={8}
										className="h-24 text-center text-muted-foreground"
									>
										No services match.
									</TableCell>
								</TableRow>
							) : null}
							{rows.map((service) => {
								const changes = pendingById.get(service.id);
								return (
									<TableRow
										key={service.id}
										data-state={
											selected.includes(service.id) ? "selected" : undefined
										}
										className="cursor-pointer"
										onClick={(event) => {
											if (
												(event.target as HTMLElement).closest(
													"a,button,[role=checkbox],[role=menu]",
												)
											)
												return;
											router.push(serviceUrl(service));
										}}
									>
										<TableCell>
											<Checkbox
												aria-label={`Select ${service.name}`}
												checked={selected.includes(service.id)}
												onCheckedChange={(checked) =>
													setSelected((prev) =>
														checked
															? [...prev, service.id]
															: prev.filter((id) => id !== service.id),
													)
												}
											/>
										</TableCell>
										<TableCell className="max-w-0">
											<div className="flex min-w-0 items-center gap-3">
												<MarkTile>
													<ServiceIcon
														kind={service.type}
														icon={service.icon}
													/>
												</MarkTile>
												<div className="flex min-w-0 flex-col">
													<Link
														href={serviceUrl(service)}
														className="w-fit max-w-full truncate font-medium hover:underline"
													>
														{service.name}
													</Link>
													<span className="truncate font-mono text-[12px] text-muted-foreground leading-4">
														{service.description || service.appName}
													</span>
												</div>
											</div>
										</TableCell>
										<TableCell>
											<div className="flex items-center gap-2">
												<ServiceStatusLabel status={service.status} />
												{changes ? (
													<span className="text-[13px] text-warning">
														· {changes} pending
													</span>
												) : null}
											</div>
										</TableCell>
										<TableCell className="text-muted-foreground max-lg:hidden">
											{SERVICE_KIND_LABELS[service.type]}
										</TableCell>
										<TableCell className="max-w-56 max-md:hidden">
											{service.domain ? (
												<a
													href={`${service.domain.https ? "https" : "http"}://${service.domain.host}${service.domain.path === "/" ? "" : service.domain.path}`}
													target="_blank"
													rel="noreferrer"
													className="block truncate font-mono text-[13px] text-muted-foreground hover:text-foreground hover:underline"
												>
													{service.domain.host}
												</a>
											) : (
												<span className="text-muted-foreground">—</span>
											)}
										</TableCell>
										<TableCell className="max-sm:hidden">
											<TimeAgo time={service.lastDeployDate} />
										</TableCell>
										{servers.length > 1 ? (
											<TableCell className="text-muted-foreground max-xl:hidden">
												{service.serverName ?? "Panara Cloud"}
											</TableCell>
										) : null}
										<TableCell className="text-right">
											<MoreMenu>
												{canDeploy ? (
													<>
														<DropdownMenuItem
															onClick={() => runOne(service, "deploy")}
														>
															<RocketIcon className="text-muted-foreground" />
															Deploy
														</DropdownMenuItem>
														<DropdownMenuItem
															onClick={() => runOne(service, "start")}
														>
															<PlayIcon className="text-muted-foreground" />
															Start
														</DropdownMenuItem>
														<DropdownMenuItem
															onClick={() => runOne(service, "stop")}
														>
															<SquareIcon className="text-muted-foreground" />
															Stop
														</DropdownMenuItem>
														<DropdownMenuSeparator />
													</>
												) : null}
												<DropdownMenuItem
													render={
														<Link
															href={`${serviceUrl(service)}/settings/general`}
														/>
													}
												>
													<SettingsIcon className="text-muted-foreground" />
													Settings
												</DropdownMenuItem>
												{permissions.service.delete ? (
													<DropdownMenuItem
														variant="destructive"
														onClick={() => setDeleting([service])}
													>
														<Trash2Icon />
														Delete
													</DropdownMenuItem>
												) : null}
											</MoreMenu>
										</TableCell>
									</TableRow>
								);
							})}
						</ResourceTable>
					</div>
					<SelectionBar
						count={selectedRows.length}
						onClear={() => setSelected([])}
					>
						{canDeploy ? (
							<>
								<Button
									variant="ghost"
									size="sm"
									disabled={busy}
									onClick={() =>
										bulk("Queued", (s) => actions.run(s, "deploy"))
									}
								>
									Deploy
								</Button>
								<Button
									variant="ghost"
									size="sm"
									disabled={busy}
									onClick={() =>
										bulk("Started", (s) => actions.run(s, "start"))
									}
								>
									Start
								</Button>
								<Button
									variant="ghost"
									size="sm"
									disabled={busy}
									onClick={() => bulk("Stopped", (s) => actions.run(s, "stop"))}
								>
									Stop
								</Button>
							</>
						) : null}
						{canManage ? (
							<Button
								variant="ghost"
								size="sm"
								disabled={busy}
								onClick={() => setMoving(true)}
							>
								Move
							</Button>
						) : null}
						{permissions.project.create ? (
							<DuplicateProject
								environmentId={environmentId}
								services={rows}
								selectedServiceIds={selected}
							/>
						) : null}
						{permissions.service.delete ? (
							<Button
								variant="ghost"
								size="sm"
								className="text-destructive"
								disabled={busy}
								onClick={() => setDeleting(selectedRows)}
							>
								Delete
							</Button>
						) : null}
					</SelectionBar>
				</>
			)}
			<MoveServicesDialog
				open={moving}
				onOpenChange={setMoving}
				count={selectedRows.length}
				currentEnvironmentId={environmentId}
				onMove={(target) => bulk("Moved", (s) => actions.move(s, target))}
			/>
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(open) => {
					if (!open) setDeleting(null);
				}}
				title={
					deleting?.length === 1
						? "Delete service?"
						: `Delete ${deleting?.length ?? 0} services?`
				}
				description="Containers and configuration are removed; volumes are kept. This cannot be undone."
				onConfirm={async () => {
					if (!deleting) return;
					await bulk("Deleted", (s) => actions.remove(s), deleting);
					setDeleting(null);
				}}
			/>
		</div>
	);
}
