"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import {
	Ban,
	CircuitBoard,
	GlobeIcon,
	Loader2,
	MoreHorizontal,
	RefreshCw,
	Search,
	ServerIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DB_ENGINE_ICONS } from "@/components/icons/data-tools-icons";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { DialogAction } from "@/components/shared/dialog-action";
import { StatusTooltip } from "@/components/shared/status-tooltip";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { SectionHeader } from "@/components/ui-kit/primitives";
import { useSortPreference } from "@/hooks/use-sort-preference";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import type {
	OverviewService,
	OverviewServiceType,
	OverviewSortBy,
} from "@/lib/shared/overview-shared";
import { sortOverviewServices } from "@/lib/shared/overview-shared";

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

const TYPE_LABELS = {
	application: "Application",
	postgres: "PostgreSQL",
	mariadb: "MariaDB",
	mongo: "MongoDB",
	mysql: "MySQL",
	redis: "Redis",
	compose: "Compose",
	libsql: "Libsql",
} satisfies Record<OverviewServiceType, string>;

const STATUS_OPTIONS = ["running", "idle", "done", "error"];

// "done" is the steady live state (green); "running" only holds mid-deploy (yellow) — relabeled to match what users expect.
const STATUS_LABELS: Record<string, string> = {
	running: "Deploying",
	idle: "Idle",
	done: "Running",
	error: "Error",
};

const SORT_OPTIONS: { value: OverviewSortBy; label: string }[] = [
	{ value: "lastDeploy-desc", label: "Recently deployed" },
	{ value: "lastDeploy-asc", label: "Oldest deployed" },
	{ value: "createdAt-desc", label: "Newest first" },
	{ value: "createdAt-asc", label: "Oldest first" },
	{ value: "name-asc", label: "Name (A-Z)" },
	{ value: "name-desc", label: "Name (Z-A)" },
	{ value: "type-asc", label: "Type (A-Z)" },
	{ value: "type-desc", label: "Type (Z-A)" },
];

const SORT_VALUES = SORT_OPTIONS.map((opt) => opt.value);

// libsql has no deploy/stop actions, same as environment/[environmentId].tsx.
const idKeyByType: Record<string, string> = {
	application: "applicationId",
	compose: "composeId",
	postgres: "databaseId",
	mysql: "databaseId",
	mariadb: "databaseId",
	redis: "databaseId",
	mongo: "databaseId",
};

export const ShowOverviewServices = () => {
	const { active } = useOrganization();
	const services = useQuery(api.platform.overview.services, {
		organizationId: active.id,
	}) as OverviewService[] | undefined;
	const isLoading = services === undefined;
	const projects = useQuery(api.projects.list, { organizationId: active.id });
	const allProjects = projects?.map((project) => ({
		projectId: project._id as string,
		name: project.name,
	}));

	const [searchQuery, setSearchQuery] = useState("");
	const [selectedProjectId, setSelectedProjectId] = useState("all");
	const [selectedType, setSelectedType] = useState("all");
	const [selectedStatus, setSelectedStatus] = useState("all");
	const [selectedServerId, setSelectedServerId] = useState("all");
	const [sortBy, setSort] = useSortPreference<OverviewSortBy>(
		"overviewServicesSort",
		"lastDeploy-desc",
		SORT_VALUES,
	);

	const deployApplication = useMutation(api.applications.deploy.deploy);
	const stopApplication = useMutation(api.applications.deploy.stop);
	const deployCompose = useMutation(api.compose.deploy.deploy);
	const stopCompose = useMutation(api.compose.deploy.stop);
	const deployDatabase = useMutation(api.databases.databases.deploy);
	const stopDatabase = useMutation(api.databases.databases.stop);

	const applicationActions = {
		deploy: { mutateAsync: deployApplication },
		stop: { mutateAsync: stopApplication },
	};
	const composeActions = {
		deploy: { mutateAsync: deployCompose },
		stop: { mutateAsync: stopCompose },
	};
	const databaseActions = {
		deploy: { mutateAsync: deployDatabase },
		stop: { mutateAsync: stopDatabase },
	};

	const actionsByType: Record<
		string,
		{
			deploy: { mutateAsync: (input: any) => Promise<unknown> };
			stop: { mutateAsync: (input: any) => Promise<unknown> };
		}
	> = {
		application: applicationActions,
		compose: composeActions,
		postgres: databaseActions,
		mysql: databaseActions,
		mariadb: databaseActions,
		redis: databaseActions,
		mongo: databaseActions,
	};

	const handleAction = async (
		service: NonNullable<typeof services>[number],
		action: "deploy" | "stop",
	) => {
		const actions = actionsByType[service.type];
		const idKey = idKeyByType[service.type];
		if (!actions || !idKey) return;

		const labels =
			action === "deploy"
				? {
						loading: "Deploying",
						success: "queued for deployment",
						error: "deploying",
					}
				: { loading: "Stopping", success: "stopped", error: "stopping" };

		toast.promise(
			(async () => {
				await actions[action].mutateAsync({ [idKey]: service.id });
			})(),
			{
				loading: `${labels.loading} ${service.name}...`,
				success: () => `${service.name} ${labels.success} successfully`,
				error: (error) =>
					`Error ${labels.error} ${service.name}: ${errorMessage(error)}`,
			},
		);
	};

	const availableServers = useMemo(() => {
		if (!services) return [];
		const map = new Map<string, string>();
		for (const service of services) {
			if (service.serverId && service.serverName) {
				map.set(service.serverId, service.serverName);
			}
		}
		return Array.from(map.entries()).map(([serverId, serverName]) => ({
			serverId,
			serverName,
		}));
	}, [services]);

	const hasServicesWithoutServer = useMemo(
		() => !!services?.some((service) => !service.serverId),
		[services],
	);

	const filteredServices = useMemo(() => {
		if (!services) return [];
		const filtered = services.filter(
			(service) =>
				service.name.toLowerCase().includes(searchQuery.toLowerCase()) &&
				(selectedProjectId === "all" ||
					service.projectId === selectedProjectId) &&
				(selectedType === "all" || service.type === selectedType) &&
				(selectedStatus === "all" || service.status === selectedStatus) &&
				(selectedServerId === "all" ||
					(selectedServerId === "panel" && !service.serverId) ||
					service.serverId === selectedServerId),
		);
		return sortOverviewServices(filtered, sortBy);
	}, [
		services,
		searchQuery,
		selectedProjectId,
		selectedType,
		selectedStatus,
		selectedServerId,
		sortBy,
	]);

	// pageIndex is clamped against the filtered count each render instead of reset via an effect.
	const [pageSize, setPageSize] = useState(50);
	const [pageIndex, setPageIndex] = useState(0);
	const pageCount = Math.max(1, Math.ceil(filteredServices.length / pageSize));
	const currentPageIndex = Math.min(pageIndex, pageCount - 1);
	const pagedServices = filteredServices.slice(
		currentPageIndex * pageSize,
		currentPageIndex * pageSize + pageSize,
	);

	const renderIcon = (service: NonNullable<typeof services>[number]) => {
		if (service.type in DB_ENGINE_ICONS) {
			const Icon =
				DB_ENGINE_ICONS[service.type as keyof typeof DB_ENGINE_ICONS];
			return <Icon className="h-5 w-5" />;
		}
		if (service.icon) {
			return (
				<img
					src={service.icon}
					alt={service.name}
					className="size-5 object-contain rounded-sm"
				/>
			);
		}
		return service.type === "compose" ? (
			<CircuitBoard className="h-5 w-5" />
		) : (
			<GlobeIcon className="h-5 w-5" />
		);
	};

	return (
		<div className="flex w-full flex-col gap-4">
			<SectionHeader title={`Services (${filteredServices.length})`}>
				<div className="relative">
					<Input
						placeholder="Filter services..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="pr-9 w-[200px]"
					/>
					<Search className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
				</div>
				<Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
					<SelectTrigger className="w-full w-[160px]">
						<SelectValue placeholder="Project" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All projects</SelectItem>
						{allProjects?.map((project) => (
							<SelectItem key={project.projectId} value={project.projectId}>
								{project.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select value={selectedType} onValueChange={setSelectedType}>
					<SelectTrigger className="w-full w-[150px]">
						<SelectValue placeholder="Type" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All types</SelectItem>
						{Object.entries(TYPE_LABELS).map(([value, label]) => (
							<SelectItem key={value} value={value}>
								{label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select value={selectedStatus} onValueChange={setSelectedStatus}>
					<SelectTrigger className="w-full w-[130px]">
						<SelectValue placeholder="Status" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All statuses</SelectItem>
						{STATUS_OPTIONS.map((status) => (
							<SelectItem key={status} value={status}>
								{STATUS_LABELS[status] ?? status}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{(availableServers.length > 0 || hasServicesWithoutServer) && (
					<Select value={selectedServerId} onValueChange={setSelectedServerId}>
						<SelectTrigger className="w-full w-[170px]">
							<SelectValue placeholder="Server" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All servers</SelectItem>
							{hasServicesWithoutServer && (
								<SelectItem value="panel">Panara Cloud server</SelectItem>
							)}
							{availableServers.map((s) => (
								<SelectItem key={s.serverId} value={s.serverId}>
									{s.serverName}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}
				<Select
					value={sortBy}
					onValueChange={(v) => setSort(v as OverviewSortBy)}
				>
					<SelectTrigger className="w-full w-[190px]">
						<SelectValue placeholder="Sort by..." />
					</SelectTrigger>
					<SelectContent>
						{SORT_OPTIONS.map((opt) => (
							<SelectItem key={opt.value} value={opt.value}>
								{opt.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</SectionHeader>

			{isLoading && (
				<div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
					<Loader2 className="size-4 animate-spin" />
					Loading services...
				</div>
			)}

			{!isLoading && filteredServices.length === 0 && (
				<div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
					<span>No services match the current filters.</span>
				</div>
			)}

			{!isLoading && filteredServices.length > 0 && (
				<>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Service</TableHead>
								<TableHead>Type</TableHead>
								<TableHead>Status</TableHead>
								<TableHead>Server</TableHead>
								<TableHead>Created</TableHead>
								<TableHead>Last Deploy</TableHead>
								<TableHead className="text-right">Actions</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{pagedServices.map((service) => {
								const href = `/projects/${service.projectId}/environment/${service.environmentId}/services/${service.type}/${service.id}`;
								const hasActions = service.type in actionsByType;
								return (
									<TableRow key={service.id}>
										<TableCell>
											<Link href={href} className="flex items-center gap-2">
												{renderIcon(service)}
												<div className="flex flex-col min-w-0">
													<span className="font-medium truncate">
														{service.name}
													</span>
													<span className="text-xs font-normal text-muted-foreground">
														{service.projectName} / {service.environmentName}
													</span>
												</div>
											</Link>
										</TableCell>
										<TableCell>{TYPE_LABELS[service.type]}</TableCell>
										<TableCell>
											<StatusTooltip
												status={service.status as any}
												className="size-2.5"
											/>
										</TableCell>
										<TableCell>
											<div className="flex items-center gap-1.5 text-muted-foreground">
												<ServerIcon className="size-3.5" />
												<span className="truncate">
													{service.serverName ?? "Panara Cloud server"}
												</span>
											</div>
										</TableCell>
										<TableCell>
											<DateTooltip date={service.createdAt} />
										</TableCell>
										<TableCell>
											{service.lastDeployAt ? (
												<DateTooltip date={service.lastDeployAt} />
											) : (
												<span className="text-muted-foreground">—</span>
											)}
										</TableCell>
										<TableCell className="text-right">
											{hasActions && (
												<DropdownMenu>
													<DropdownMenuTrigger
														render={
															<Button variant="ghost" className="h-8 w-8 p-0" />
														}
													>
														<span className="sr-only">Open menu</span>
														<MoreHorizontal className="h-4 w-4" />
													</DropdownMenuTrigger>
													<DropdownMenuContent align="end">
														<DropdownMenuGroup>
															<DropdownMenuLabel className="truncate">
																{service.name}
															</DropdownMenuLabel>
														</DropdownMenuGroup>
														<DialogAction
															title="Deploy Service"
															description={`Are you sure you want to deploy "${service.name}"?`}
															type="default"
															onClick={() => handleAction(service, "deploy")}
														>
															<DropdownMenuItem
																className="flex items-center gap-2"
																closeOnClick={false}
															>
																<RefreshCw className="size-4" />
																Deploy
															</DropdownMenuItem>
														</DialogAction>
														<DialogAction
															title="Stop Service"
															description={`Are you sure you want to stop "${service.name}"?`}
															onClick={() => handleAction(service, "stop")}
														>
															<DropdownMenuItem
																className="flex items-center gap-2 text-orange-500 focus:text-orange-500"
																closeOnClick={false}
															>
																<Ban className="size-4" />
																Stop
															</DropdownMenuItem>
														</DialogAction>
													</DropdownMenuContent>
												</DropdownMenu>
											)}
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>

					<div className="flex items-center justify-between text-sm text-muted-foreground">
						<span>
							{filteredServices.length}{" "}
							{filteredServices.length === 1 ? "service" : "services"} total
						</span>
						<div className="flex items-center gap-3">
							<div className="flex items-center gap-2">
								<span className="whitespace-nowrap">Rows per page</span>
								<Select
									value={String(pageSize)}
									onValueChange={(value) => {
										setPageSize(Number(value));
										setPageIndex(0);
									}}
								>
									<SelectTrigger className="w-full w-[80px] h-8">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{PAGE_SIZE_OPTIONS.map((size) => (
											<SelectItem key={size} value={String(size)}>
												{size}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<span className="whitespace-nowrap">
								Page {currentPageIndex + 1} of {pageCount}
							</span>
							<div className="flex gap-2">
								<Button
									variant="outline"
									size="sm"
									onClick={() => setPageIndex(currentPageIndex - 1)}
									disabled={currentPageIndex === 0}
								>
									Previous
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setPageIndex(currentPageIndex + 1)}
									disabled={currentPageIndex + 1 >= pageCount}
								>
									Next
								</Button>
							</div>
						</div>
					</div>
				</>
			)}
		</div>
	);
};
