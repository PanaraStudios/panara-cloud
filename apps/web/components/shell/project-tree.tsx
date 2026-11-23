"use client";

import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Monogram } from "@/components/icons/service-icons";
import {
	SERVICE_STATUS,
	StatusDot,
} from "@/components/project-pages/service-status";
import { ServiceIcon } from "@/components/service/service-icon";
import {
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	environmentUrl,
	isServiceKind,
	navLevel,
	projectUrl,
	serviceUrl,
} from "@/lib/navigation";
import {
	defaultEnvironment,
	type TreeEnvironment,
	type TreeProject,
	treeStatus,
} from "@/lib/navigation-tree";
import { usePermissions } from "@/lib/permissions";
import { usePathname } from "@/lib/router";
import Link from "@/lib/router/link";
import { cn } from "@/lib/utils";

// The organization's projects as a tree: a project opens to its services,
// under their environment when it has several. It stays short by itself:
// one environment is open at a time unless more are opened by hand, a long
// list of services ends in "Show all", and what was opened or closed is
// remembered on this device.

const TREE_KEY = "panara-cloud:sidebar-tree";
// More projects than this and the list ends in "All projects".
const MAX_PROJECTS = 8;
// More services than this (by more than one) and the list ends in "Show all".
const MAX_SERVICES = 6;

type TreeState = {
	/** Projects and environments opened or closed by hand. */
	projects: Record<string, boolean>;
	environments: Record<string, boolean>;
	/** Environments showing every service. */
	full: string[];
	/** The project worked in last. */
	last?: string;
};

const EMPTY: TreeState = { projects: {}, environments: {}, full: [] };

function useTreeState(active: { projectId?: string; environmentId?: string }) {
	const [state, setState] = useState(EMPTY);
	const [loaded, setLoaded] = useState(false);
	useEffect(() => {
		try {
			const stored = JSON.parse(window.localStorage.getItem(TREE_KEY) ?? "{}");
			setState({
				projects: stored.projects ?? {},
				environments: stored.environments ?? {},
				full: Array.isArray(stored.full) ? stored.full : [],
				last: stored.last,
			});
		} catch {}
		setLoaded(true);
	}, []);
	// Arriving somewhere opens the way to it, whatever was closed before.
	const { projectId, environmentId } = active;
	useEffect(() => {
		if (!projectId) return;
		setState((current) => {
			const closedProject = current.projects[projectId] === false;
			const closedEnvironment =
				!!environmentId && current.environments[environmentId] === false;
			if (current.last === projectId && !closedProject && !closedEnvironment) {
				return current;
			}
			const { [projectId]: _, ...projects } = current.projects;
			const { [environmentId ?? ""]: __, ...environments } =
				current.environments;
			return {
				...current,
				last: projectId,
				projects: closedProject ? projects : current.projects,
				environments: closedEnvironment ? environments : current.environments,
			};
		});
	}, [projectId, environmentId]);
	useEffect(() => {
		if (!loaded) return;
		try {
			window.localStorage.setItem(TREE_KEY, JSON.stringify(state));
		} catch {}
	}, [loaded, state]);
	return { state, setState, loaded };
}

const subRow = "h-7 gap-2 pr-1.5 pl-2";
const trailing =
	"flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-hidden ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 [&>svg]:size-3.5";

/** A row's tooltip, beside the sidebar. A row that only names something
    shows it when the name is cut off; `always` is for a row whose dot needs
    its word. */
export function RowTip({
	label,
	always = false,
	children,
}: {
	label: string;
	always?: boolean;
	children: React.ReactElement;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Tooltip
			open={open}
			onOpenChange={(next, details) => {
				if (next && !always) {
					const target = details.event.target;
					const text =
						target instanceof Element
							? target
									.closest("[data-tree-row]")
									?.querySelector("[data-tree-label]")
							: null;
					if (!text || text.scrollWidth <= text.clientWidth) return;
				}
				setOpen(next);
			}}
		>
			<TooltipTrigger render={children} />
			<TooltipContent side="right">{label}</TooltipContent>
		</Tooltip>
	);
}

export function RowLabel({ children }: { children: React.ReactNode }) {
	return (
		<span data-tree-label className="min-w-0 flex-1 truncate">
			{children}
		</span>
	);
}

function Chevron({ open }: { open: boolean }) {
	return (
		<ChevronRightIcon
			className={cn(
				"transition-transform duration-150 motion-reduce:transition-none",
				open && "rotate-90",
			)}
		/>
	);
}

function ServiceRows({
	project,
	environment,
	activeServiceId,
	full,
	onToggleFull,
}: {
	project: TreeProject;
	environment: TreeEnvironment;
	activeServiceId: string | undefined;
	full: boolean;
	onToggleFull: () => void;
}) {
	const services = environment.services.filter((service) =>
		isServiceKind(service.type),
	);
	const long = services.length > MAX_SERVICES + 1;
	// The open service stays in sight when the list is cut.
	const shown =
		long && !full
			? services.filter(
					(service, index) =>
						index < MAX_SERVICES || service.id === activeServiceId,
				)
			: services;
	return (
		<>
			{shown.map((service) => {
				if (!isServiceKind(service.type)) return null;
				const current = service.id === activeServiceId;
				const status = SERVICE_STATUS[treeStatus(service)];
				return (
					<SidebarMenuSubItem key={service.id}>
						<RowTip always label={`${service.name} · ${status.label}`}>
							<SidebarMenuSubButton
								data-tree-row
								isActive={current}
								aria-current={current ? "page" : undefined}
								className={subRow}
								render={
									<Link
										href={serviceUrl({
											projectId: project.projectId,
											environmentId: environment.environmentId,
											kind: service.type,
											id: service.id,
										})}
									/>
								}
							>
								<span className="flex size-4 shrink-0 items-center justify-center">
									<ServiceIcon
										kind={service.type}
										icon={service.icon}
										className="size-3.5!"
										imageClassName="size-4"
									/>
								</span>
								<RowLabel>{service.name}</RowLabel>
								<StatusDot
									status={service.status}
									runtime={service.runtime ?? undefined}
									className="mr-1"
								/>
								<span className="sr-only">{status.label}</span>
							</SidebarMenuSubButton>
						</RowTip>
					</SidebarMenuSubItem>
				);
			})}
			{long ? (
				<li>
					<button
						type="button"
						aria-expanded={full}
						className="flex h-6 w-full items-center rounded-md px-2 text-left text-muted-foreground/80 text-xs outline-hidden ring-sidebar-ring transition-colors hover:text-foreground focus-visible:ring-2"
						onClick={onToggleFull}
					>
						{full ? "Show fewer" : `Show all ${services.length}`}
					</button>
				</li>
			) : null}
		</>
	);
}

function EnvironmentRows({
	project,
	environment,
	open,
	onToggle,
	current,
	children,
}: {
	project: TreeProject;
	environment: TreeEnvironment;
	open: boolean;
	onToggle: () => void;
	/** The environment's own page is open. */
	current: boolean;
	children: React.ReactNode;
}) {
	const count = environment.services.length;
	return (
		<li className="relative">
			<RowTip label={environment.name}>
				<Link
					data-tree-row
					href={environmentUrl(project.projectId, environment.environmentId)}
					aria-current={current ? "page" : undefined}
					className={cn(
						"flex h-6 -translate-x-px items-center rounded-md pr-12 pl-2 text-muted-foreground text-xs outline-hidden ring-sidebar-ring transition-colors hover:text-foreground focus-visible:ring-2",
						current && "bg-sidebar-active font-medium text-foreground",
					)}
				>
					<RowLabel>{environment.name}</RowLabel>
				</Link>
			</RowTip>
			<button
				type="button"
				aria-expanded={open}
				aria-label={`${open ? "Hide" : "Show"} the ${count} services of ${environment.name}`}
				className="absolute top-0 right-1 flex h-6 items-center gap-1 rounded-md pl-1.5 text-muted-foreground text-xs tabular-nums outline-hidden ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2"
				onClick={onToggle}
			>
				{open ? null : count}
				<span className="flex size-5 items-center justify-center [&>svg]:size-3.5">
					<Chevron open={open} />
				</span>
			</button>
			{open ? (
				<ul className="flex flex-col gap-0.5 pt-0.5">{children}</ul>
			) : null}
		</li>
	);
}

function ProjectRow({
	project,
	open,
	onToggle,
	current,
	activeEnvironmentId,
	activeServiceId,
	state,
	onToggleEnvironment,
	onToggleFull,
}: {
	project: TreeProject;
	open: boolean;
	onToggle: () => void;
	/** The project's own page is open (not one of its services). */
	current: boolean;
	activeEnvironmentId: string | undefined;
	activeServiceId: string | undefined;
	state: TreeState;
	onToggleEnvironment: (environmentId: string, open: boolean) => void;
	onToggleFull: (environmentId: string) => void;
}) {
	const permissions = usePermissions();
	const main = defaultEnvironment(project);
	const href = main
		? environmentUrl(project.projectId, main.environmentId)
		: `${projectUrl(project.projectId)}/settings`;
	const here = project.environments.find(
		(item) => item.environmentId === activeEnvironmentId,
	);
	const listed = project.environments.filter(
		(item) => item.services.length > 0 || item === here,
	);
	// Open unless said otherwise: the environment being worked in, else the
	// default one (or the first that has anything).
	const primary =
		here ?? (main && listed.includes(main) ? main : (listed[0] ?? main));
	const environmentOpen = (environment: TreeEnvironment) =>
		state.environments[environment.environmentId] ?? environment === primary;
	const target = here ?? main;
	const canAdd = permissions.service.create && target;
	const rows = (environment: TreeEnvironment) => (
		<ServiceRows
			key={environment.environmentId}
			project={project}
			environment={environment}
			activeServiceId={activeServiceId}
			full={state.full.includes(environment.environmentId)}
			onToggleFull={() => onToggleFull(environment.environmentId)}
		/>
	);
	return (
		<SidebarMenuSubItem>
			{/* The row alone, so "New service" shows from it and not from the rows under it. */}
			<div className="group/project relative">
				<RowTip label={project.name}>
					<SidebarMenuSubButton
						data-tree-row
						// With its environments listed, the open one carries the mark.
						isActive={
							current && !(open && here && project.environments.length > 1)
						}
						aria-current={current ? "page" : undefined}
						className={cn(
							subRow,
							"pr-7 text-foreground/85",
							canAdd &&
								"group-focus-within/project:pr-12 group-hover/project:pr-12",
						)}
						render={<Link href={href} />}
					>
						<Monogram
							name={project.name}
							className="size-4.5 rounded-[5px] text-[10px]"
						/>
						<RowLabel>{project.name}</RowLabel>
					</SidebarMenuSubButton>
				</RowTip>
				<span className="absolute top-1 right-1 flex items-center gap-0.5">
					{canAdd ? (
						<Tooltip>
							<TooltipTrigger
								render={
									<Link
										href={`${environmentUrl(project.projectId, target.environmentId)}/new`}
										aria-label={`New service in ${project.name}`}
										className={cn(
											trailing,
											"opacity-0 focus-visible:opacity-100 group-focus-within/project:opacity-100 group-hover/project:opacity-100",
										)}
									/>
								}
							>
								<PlusIcon />
							</TooltipTrigger>
							<TooltipContent side="right">New service</TooltipContent>
						</Tooltip>
					) : null}
					<button
						type="button"
						aria-expanded={open}
						aria-label={`${open ? "Hide" : "Show"} the services of ${project.name}`}
						className={trailing}
						onClick={onToggle}
					>
						<Chevron open={open} />
					</button>
				</span>
			</div>
			{open ? (
				<ul
					aria-label={`Services of ${project.name}`}
					className="flex flex-col gap-0.5 py-0.5 pl-[26px] motion-safe:fade-in-0 motion-safe:animate-in motion-safe:duration-150"
				>
					{listed.length === 0 ? (
						<li className="flex h-7 items-center px-2 text-muted-foreground/70 text-sm">
							No services yet
						</li>
					) : project.environments.length > 1 ? (
						listed.map((environment) => (
							<EnvironmentRows
								key={environment.environmentId}
								project={project}
								environment={environment}
								open={environmentOpen(environment)}
								onToggle={() =>
									onToggleEnvironment(
										environment.environmentId,
										!environmentOpen(environment),
									)
								}
								current={current && environment === here}
							>
								{rows(environment)}
							</EnvironmentRows>
						))
					) : (
						listed.map(rows)
					)}
				</ul>
			) : null}
		</SidebarMenuSubItem>
	);
}

export function ProjectTree({
	projects,
	className,
}: {
	projects: TreeProject[];
	className?: string;
}) {
	const level = navLevel(usePathname());
	const inProject = level.level === "project" || level.level === "service";
	const activeProjectId = inProject ? level.projectId : undefined;
	const activeEnvironmentId = inProject ? level.environmentId : undefined;
	const activeServiceId = level.level === "service" ? level.id : undefined;
	const { state, setState, loaded } = useTreeState({
		projectId: activeProjectId,
		environmentId: activeEnvironmentId,
	});
	const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));
	const untouched =
		loaded && !state.last && Object.keys(state.projects).length === 0;
	const isOpen = (project: TreeProject) =>
		state.projects[project.projectId] ??
		(project.projectId === activeProjectId ||
			project.projectId === state.last ||
			// Nothing to go by yet: the first one shows what a project holds.
			(untouched && project === sorted[0]));
	// Past the cap, the project being worked in and the open ones stay.
	const kept = sorted.filter(isOpen);
	const rest = sorted
		.filter((project) => !kept.includes(project))
		.slice(0, Math.max(0, MAX_PROJECTS - kept.length));
	const shown =
		sorted.length <= MAX_PROJECTS
			? sorted
			: sorted.filter(
					(project) => kept.includes(project) || rest.includes(project),
				);

	useEffect(() => {
		if (!activeServiceId) return;
		document
			.querySelector('[data-sidebar="menu-sub"] [aria-current="page"]')
			?.scrollIntoView({ block: "nearest" });
	}, [activeServiceId]);

	return (
		<SidebarMenuSub
			aria-label="Projects"
			className={cn("mr-0 gap-0.5 pr-0", className)}
		>
			{shown.map((project) => (
				<ProjectRow
					key={project.projectId}
					project={project}
					open={isOpen(project)}
					onToggle={() =>
						setState((current) => ({
							...current,
							projects: {
								...current.projects,
								[project.projectId]: !isOpen(project),
							},
						}))
					}
					current={
						project.projectId === activeProjectId && level.level === "project"
					}
					activeEnvironmentId={
						project.projectId === activeProjectId
							? activeEnvironmentId
							: undefined
					}
					activeServiceId={activeServiceId}
					state={state}
					onToggleEnvironment={(environmentId, open) =>
						setState((current) => ({
							...current,
							environments: { ...current.environments, [environmentId]: open },
						}))
					}
					onToggleFull={(environmentId) =>
						setState((current) => ({
							...current,
							full: current.full.includes(environmentId)
								? current.full.filter((id) => id !== environmentId)
								: [...current.full, environmentId],
						}))
					}
				/>
			))}
			{sorted.length > shown.length ? (
				<SidebarMenuSubItem>
					<SidebarMenuSubButton
						className={cn(subRow, "text-muted-foreground/80")}
						render={<Link href="/" />}
					>
						<span>All {sorted.length} projects</span>
					</SidebarMenuSubButton>
				</SidebarMenuSubItem>
			) : null}
		</SidebarMenuSub>
	);
}
