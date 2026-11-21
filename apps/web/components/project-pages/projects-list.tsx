"use client";

import { api } from "@panara-cloud/backend/api";
import { usePaginatedQuery, useQuery } from "convex/react";
import {
	ActivityIcon,
	ArrowRightIcon,
	BookOpenIcon,
	FolderIcon,
	SettingsIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ExportProject } from "@/components/dashboard/project/export-import/export-project";
import { ImportProject } from "@/components/dashboard/project/export-import/import-project";
import { SetupChecklist } from "@/components/dashboard/setup/setup-checklist";
import { Monogram } from "@/components/icons/service-icons";
import { ServiceIcon } from "@/components/service/service-icon";
import { Toolbar, ToolbarSearch } from "@/components/shared/list-toolbar";
import { TagFilter } from "@/components/shared/tag-filter";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	EmptyState,
	MoreMenu,
	PageHeader,
	ResourceTable,
	Section,
	Th,
	useListSearch,
} from "@/components/ui-kit/primitives";
import { isServiceKind, serviceUrl } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { NewProjectDialog } from "./new-project-dialog";
import { type ServiceStatus, StatusDot } from "./service-status";
import { TimeAgo } from "./time-ago";

const STATUS_ORDER: ServiceStatus[] = ["error", "running", "done", "idle"];

/** Org home: every project as a table row. */
export function ProjectsList() {
	const router = useRouter();
	const { active } = useOrganization();
	const permissions = usePermissions();
	const canTransfer = active.role === "owner" || active.role === "admin";
	const projects = useQuery(api.projects.all, { organizationId: active.id });
	const tags = useQuery(api.platform.tags.list, { organizationId: active.id });
	const { query, setQuery, search } = useListSearch();
	const [tagIds, setTagIds] = useState<string[]>([]);
	const [sort, setSort] = useState<"activity" | "name" | "created">("activity");
	const [importSignal, setImportSignal] = useState(0);

	const rows = useMemo(() => {
		const needle = search.trim().toLowerCase();
		return (projects ?? [])
			.filter(
				(project) =>
					!needle ||
					project.name.toLowerCase().includes(needle) ||
					project.description?.toLowerCase().includes(needle),
			)
			.filter(
				(project) =>
					tagIds.length === 0 ||
					project.tags.some((tag) => tagIds.includes(tag.tagId)),
			)
			.sort((a, b) =>
				sort === "name"
					? a.name.localeCompare(b.name)
					: sort === "created"
						? b.createdAt - a.createdAt
						: (b.lastDeployAt ?? b.createdAt) - (a.lastDeployAt ?? a.createdAt),
			);
	}, [projects, search, tagIds, sort]);

	const canImport = permissions.project.create && canTransfer;
	const importer = canImport ? (
		<span className="hidden">
			<ImportProject openSignal={importSignal} />
		</span>
	) : null;
	const newProject = permissions.project.create ? (
		<NewProjectDialog
			onImport={canImport ? () => setImportSignal((n) => n + 1) : undefined}
		/>
	) : null;

	const href = (project: NonNullable<typeof projects>[number]) => {
		const environment =
			project.environments.find((env) => env.isDefault) ??
			project.environments[0];
		return environment
			? `/projects/${project.projectId}/environment/${environment.environmentId}`
			: `/projects/${project.projectId}/settings`;
	};

	return (
		<div className="flex w-full flex-col gap-6">
			<PageHeader
				title="Projects"
				description="Everything you deploy, grouped by project."
			>
				<Button
					variant="ghost"
					nativeButton={false}
					render={
						<a href={DOCS_URL} target="_blank" rel="noreferrer">
							<BookOpenIcon data-icon="inline-start" />
							Docs
						</a>
					}
				/>
				{newProject}
			</PageHeader>
			{importer}
			{projects === undefined ? null : projects.length === 0 ? (
				<>
					<EmptyState
						icon={FolderIcon}
						title="Ship your first project"
						description="Projects hold the apps, databases and compose stacks that ship together. Panara Cloud host is ready to run them."
					>
						<div className="flex gap-2">
							{canImport ? (
								<ImportProject label="Import .json" icon={false} />
							) : null}
							{permissions.project.create ? (
								<NewProjectDialog icon={false} />
							) : null}
						</div>
					</EmptyState>
					<SetupChecklist />
				</>
			) : (
				<>
					<div className="flex flex-col gap-4">
						<Toolbar>
							<ToolbarSearch
								value={query}
								onChange={setQuery}
								placeholder="Search projects…"
							/>
							{tags && tags.length > 0 ? (
								<TagFilter
									tags={tags.map((tag) => ({
										id: tag._id,
										name: tag.name,
										color: tag.color || undefined,
									}))}
									selectedTags={tagIds}
									onTagsChange={setTagIds}
								/>
							) : null}
							<Select
								value={sort}
								onValueChange={(value) => setSort(value as typeof sort)}
							>
								<SelectTrigger aria-label="Sort projects" className="ml-auto">
									<span className="text-muted-foreground">Sort</span>
									<span className="font-medium">
										<SelectValue />
									</span>
								</SelectTrigger>
								<SelectContent align="end">
									<SelectItem value="activity">Last activity</SelectItem>
									<SelectItem value="name">Name</SelectItem>
									<SelectItem value="created">Newest</SelectItem>
								</SelectContent>
							</Select>
						</Toolbar>
						<ResourceTable
							headers={
								<>
									<Th className="w-[38%]">Project</Th>
									<Th>Services</Th>
									<Th className="max-md:hidden">Environments</Th>
									<Th className="max-sm:hidden">Last deploy</Th>
									<Th className="w-12" />
								</>
							}
						>
							{rows.length === 0 ? (
								<TableRow>
									<TableCell
										colSpan={5}
										className="h-24 text-center text-muted-foreground"
									>
										No projects match.
									</TableCell>
								</TableRow>
							) : null}
							{rows.map((project) => {
								const lastService = project.environments
									.flatMap((env) => env.services)
									.filter((service) => service.status !== "idle")[0];
								const services = project.environments.flatMap(
									(env) => env.services,
								);
								const counts = STATUS_ORDER.map((status) => ({
									status,
									count: services.filter((s) => s.status === status).length,
								})).filter((entry) => entry.count > 0);
								return (
									<TableRow
										key={project.projectId}
										className="cursor-pointer"
										onClick={(event) => {
											if ((event.target as HTMLElement).closest("a,button"))
												return;
											router.push(href(project));
										}}
									>
										<TableCell className="max-w-0">
											<div className="flex min-w-0 items-center gap-3">
												<Monogram name={project.name} />
												<div className="flex min-w-0 flex-col">
													<Link
														href={href(project)}
														className="w-fit max-w-full truncate font-medium hover:underline"
													>
														{project.name}
													</Link>
													{project.description ? (
														<span className="truncate text-[13px] text-muted-foreground leading-4">
															{project.description}
														</span>
													) : null}
												</div>
											</div>
										</TableCell>
										<TableCell>
											{services.length === 0 ? (
												<span className="text-muted-foreground">
													No services
												</span>
											) : (
												<div className="flex items-center gap-2">
													<span className="flex items-center gap-1">
														{services.slice(0, 6).map((service) => (
															<StatusDot
																key={service.id}
																status={service.status}
															/>
														))}
													</span>
													<span>
														{servicesSummary(counts, services.length)}
													</span>
												</div>
											)}
										</TableCell>
										<TableCell className="text-muted-foreground max-md:hidden">
											{project.environments.length <= 3
												? project.environments
														.map((env) => env.name)
														.join(" · ")
												: `${project.environments.length} environments`}
										</TableCell>
										<TableCell className="max-sm:hidden">
											{project.lastDeployAt ? (
												<span className="inline-flex items-center gap-2">
													{lastService ? (
														<span className="font-medium">
															{lastService.name}
														</span>
													) : null}
													<TimeAgo time={project.lastDeployAt} />
												</span>
											) : (
												<span className="text-muted-foreground">
													Never deployed
												</span>
											)}
										</TableCell>
										<TableCell className="text-right">
											<MoreMenu>
												<DropdownMenuItem
													render={
														<Link
															href={`/projects/${project.projectId}/settings`}
														/>
													}
												>
													<SettingsIcon className="text-muted-foreground" />
													Settings
												</DropdownMenuItem>
												{canTransfer ? (
													<ExportProject
														projectId={project.projectId}
														environments={project.environments}
													/>
												) : null}
											</MoreMenu>
										</TableCell>
									</TableRow>
								);
							})}
						</ResourceTable>
					</div>
					<SetupChecklist />
					{permissions.deployment.read ? <RecentActivity /> : null}
				</>
			)}
		</div>
	);
}

const SUMMARY_LABEL: Record<ServiceStatus, string> = {
	done: "live",
	running: "deploying",
	error: "failed",
	idle: "not deployed",
};

function servicesSummary(
	counts: { status: ServiceStatus; count: number }[],
	total: number,
) {
	if (counts.length === 1 && counts[0])
		return `${counts[0].count} ${SUMMARY_LABEL[counts[0].status]}`;
	const live = counts.find((entry) => entry.status === "done")?.count ?? 0;
	return live > 0 ? `${live} of ${total} live` : `${total} services`;
}

const RECENT = 5;

const DEPLOYMENT_DOT: Record<string, ServiceStatus> = {
	done: "done",
	running: "running",
	error: "error",
	cancelled: "idle",
};

const DEPLOYMENT_WORD: Record<string, string> = {
	done: "is live",
	running: "is deploying",
	error: "failed",
	cancelled: "was cancelled",
};

/** The last few deployments across the organization. */
function RecentActivity() {
	const { active } = useOrganization();
	const { results, status } = usePaginatedQuery(
		api.platform.overview.deployments,
		{ organizationId: active.id },
		{ initialNumItems: RECENT },
	);
	if (status === "LoadingFirstPage" || results.length === 0) return null;
	return (
		<Section
			className="mt-2"
			title="Recent activity"
			icon={ActivityIcon}
			actions={
				<Link
					href="/activity/deployments"
					className="inline-flex items-center gap-1 text-muted-foreground text-small hover:text-foreground"
				>
					View all
					<ArrowRightIcon className="size-3.5" />
				</Link>
			}
		>
			<ul className="divide-y divide-border">
				{results.slice(0, RECENT).map((row) => {
					const service = row.service;
					const href =
						service.type === "application" || service.type === "compose"
							? serviceUrl(
									{
										projectId: service.projectId,
										environmentId: service.environmentId,
										kind: service.type,
										id: service.id,
									},
									`deployments/${row.deploymentId}`,
								)
							: undefined;
					return (
						<li key={row.deploymentId}>
							<Link
								href={href ?? "/activity/deployments"}
								className="flex min-h-11 items-center gap-3 py-2 text-sm hover:text-foreground"
							>
								<StatusDot status={DEPLOYMENT_DOT[row.status] ?? "idle"} />
								<span className="min-w-0 flex-1 truncate">
									Deployment {DEPLOYMENT_WORD[row.status] ?? row.status}
									<span className="text-muted-foreground"> · {row.title}</span>
								</span>
								<span className="flex shrink-0 items-center gap-2 text-muted-foreground max-sm:hidden">
									{isServiceKind(service.type) ? (
										<ServiceIcon kind={service.type} className="size-3.5" />
									) : null}
									{service.projectName} / {service.name}
								</span>
								<span className="w-28 shrink-0 text-right text-muted-foreground">
									<TimeAgo time={new Date(row.createdAt).getTime()} />
								</span>
							</Link>
						</li>
					);
				})}
			</ul>
		</Section>
	);
}

const DOCS_URL = "https://github.com/PanaraStudios/panara-cloud/tree/main/docs";
