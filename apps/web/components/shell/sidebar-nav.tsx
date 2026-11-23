"use client";

import { PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { PanelMark } from "@/components/icons/server-icons";
import { NewProjectDialog } from "@/components/project-pages/new-project-dialog";
import {
	LOCAL_SERVER_NAME,
	serverStatus,
} from "@/components/servers/use-server";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	SidebarMenuAction,
	SidebarMenuBadge,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
	useSidebar,
} from "@/components/ui/sidebar";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { toneDotClassName } from "@/components/ui-kit/primitives";
import {
	LOCAL_SERVER_ID,
	type NavItem,
	navLevel,
	orgNav,
	serverUrl,
	sidebarState,
	visibleItems,
} from "@/lib/navigation";
import {
	type TreeProject,
	type TreeServer,
	treeStatus,
	useNavigationTree,
} from "@/lib/navigation-tree";
import { useIsInstanceAdmin } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { usePathname } from "@/lib/router";
import Link from "@/lib/router/link";
import { cn } from "@/lib/utils";
import { ProjectTree, RowLabel, RowTip } from "./project-tree";
import { NavigationKeys } from "./shortcuts-dialog";

// The sidebar's items, the same on every page: Projects · Activity ·
// Servers, with Settings above the footer. Projects lists the organization's
// projects and, under an open one, its services with their state; Servers
// lists the servers. The list never swaps for another one: a page only moves
// the highlight. Collapsed to a rail, Projects opens the same tree beside it.

type ItemState = "current" | "ancestor" | undefined;

const navTooltip = (item: NavItem) => (
	<>
		{item.title}
		<NavigationKeys shortcut={item.shortcut} />
	</>
);

function NavButton({ item, state }: { item: NavItem; state: ItemState }) {
	return (
		<SidebarMenuButton
			isActive={state === "current"}
			aria-current={state === "current" ? "page" : undefined}
			className={
				state === "ancestor" ? "font-medium text-foreground" : undefined
			}
			tooltip={{
				// A shortcut is worth a tooltip next to its label too.
				...(item.shortcut ? { hidden: false } : null),
				children: navTooltip(item),
			}}
			render={<Link href={item.url} />}
		>
			<item.icon />
			<span className="min-w-0 flex-1 truncate">{item.title}</span>
		</SidebarMenuButton>
	);
}

/** Projects on the collapsed rail: the tree opens beside the icon. */
function ProjectsFlyout({
	item,
	state,
	projects,
}: {
	item: NavItem;
	state: ItemState;
	projects: TreeProject[];
}) {
	const pathname = usePathname();
	const [open, setOpen] = useState(false);
	// A page opened from the flyout takes its place.
	useEffect(() => setOpen(false), [pathname]);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<SidebarMenuButton
						isActive={state !== undefined}
						aria-label={item.title}
						tooltip={{ hidden: open, children: navTooltip(item) }}
					/>
				}
			>
				<item.icon />
			</PopoverTrigger>
			<PopoverContent
				side="right"
				align="start"
				sideOffset={10}
				className="max-h-[min(36rem,calc(100svh-1.5rem))] w-64 gap-1 overflow-y-auto p-1.5"
			>
				<div className="flex h-7 items-center justify-between pr-1.5 pl-2 text-xs">
					<span className="text-muted-foreground">Projects</span>
					<Link
						href={item.url}
						className="rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
						onClick={() => setOpen(false)}
					>
						View all
					</Link>
				</div>
				<ProjectTree projects={projects} className="mx-0 border-l-0 px-0" />
			</PopoverContent>
		</Popover>
	);
}

function ServerRow({
	href,
	name,
	status,
	current,
}: {
	href: string;
	name: string;
	/** Absent for the panel host, which has no health of its own to show. */
	status?: ReturnType<typeof serverStatus>;
	current: boolean;
}) {
	return (
		<SidebarMenuSubItem>
			<RowTip
				always={!!status}
				label={status ? `${name} · ${status.label}` : name}
			>
				<SidebarMenuSubButton
					data-tree-row
					isActive={current}
					aria-current={current ? "page" : undefined}
					className="h-7 gap-2 pr-1.5 pl-2"
					render={<Link href={href} />}
				>
					<span className="flex size-4.5 shrink-0 items-center justify-center">
						{status ? (
							<span
								className={cn(
									"size-1.5 rounded-full",
									toneDotClassName(status.tone),
								)}
							/>
						) : (
							<PanelMark className="size-3.5" />
						)}
					</span>
					<RowLabel>{name}</RowLabel>
					{status ? <span className="sr-only">{status.label}</span> : null}
				</SidebarMenuSubButton>
			</RowTip>
		</SidebarMenuSubItem>
	);
}

function ServerList({
	servers,
	withHost,
}: {
	servers: TreeServer[];
	withHost: boolean;
}) {
	const level = navLevel(usePathname());
	const activeId = level.level === "server" ? level.serverId : undefined;
	return (
		<SidebarMenuSub aria-label="Servers" className="mr-0 gap-0.5 pr-0">
			{withHost ? (
				<ServerRow
					href={serverUrl(LOCAL_SERVER_ID)}
					name={LOCAL_SERVER_NAME}
					current={activeId === LOCAL_SERVER_ID}
				/>
			) : null}
			{servers.map((server) => (
				<ServerRow
					key={server.serverId}
					href={serverUrl(server.serverId)}
					name={server.name}
					status={serverStatus(server)}
					current={activeId === server.serverId}
				/>
			))}
		</SidebarMenuSub>
	);
}

export function SidebarNav() {
	const pathname = usePathname();
	const permissions = usePermissions();
	const instanceAdmin = useIsInstanceAdmin();
	const sidebar = useSidebar();
	const collapsed = sidebar.state === "collapsed" && !sidebar.isMobile;
	const tree = useNavigationTree();
	const projects = tree?.projects ?? [];
	const servers = tree?.servers ?? [];
	const busy = projects
		.flatMap((project) => project.environments)
		.flatMap((environment) => environment.services)
		.filter((service) =>
			["deploying", "queued"].includes(treeStatus(service)),
		).length;
	// One server needs no list: the row itself opens it.
	const listServers = servers.length + (instanceAdmin ? 1 : 0) > 1;

	return visibleItems(orgNav, permissions)
		.filter((item) => item.url !== "/settings")
		.map((item) => {
			const state = sidebarState(pathname, item);
			const isProjects = item.url === "/";
			const listed =
				!collapsed &&
				(isProjects
					? projects.length > 0
					: item.url === "/servers" && listServers);
			return (
				<SidebarMenuItem key={item.url}>
					{isProjects && collapsed && projects.length > 0 ? (
						<ProjectsFlyout item={item} state={state} projects={projects} />
					) : (
						<NavButton
							item={item}
							// With its list out of sight, the row stands for the page
							// open under it.
							state={state === "ancestor" && !listed ? "current" : state}
						/>
					)}
					{isProjects && permissions.project.create ? (
						<Tooltip>
							<NewProjectDialog
								trigger={
									<TooltipTrigger
										render={
											<SidebarMenuAction
												aria-label="New project"
												// Shown from the Projects row only, not from
												// the rows listed under it.
												className="text-muted-foreground hover:opacity-100 focus-visible:opacity-100 peer-hover/menu-button:opacity-100 data-popup-open:opacity-100 md:opacity-0"
											/>
										}
									>
										<PlusIcon />
									</TooltipTrigger>
								}
							/>
							<TooltipContent side="right">New project</TooltipContent>
						</Tooltip>
					) : null}
					{item.url === "/activity" && busy > 0 ? (
						<>
							<SidebarMenuBadge
								role="status"
								aria-label={`${busy} deploying`}
								className="right-2 gap-1.5 font-normal text-muted-foreground"
							>
								<span className="size-1.5 animate-pulse rounded-full bg-info motion-reduce:animate-none" />
								{busy}
							</SidebarMenuBadge>
							{/* On the rail the count is a dot on the icon. */}
							<span
								aria-hidden
								className="pointer-events-none absolute top-1.5 right-1.5 hidden size-1.5 animate-pulse rounded-full bg-info motion-reduce:animate-none group-data-[collapsible=icon]:block"
							/>
						</>
					) : null}
					{isProjects && listed ? <ProjectTree projects={projects} /> : null}
					{item.url === "/servers" && listed ? (
						<ServerList servers={servers} withHost={instanceAdmin} />
					) : null}
				</SidebarMenuItem>
			);
		});
}

/** Settings, above the footer: one row that opens the Settings hub. */
export function SidebarSettings() {
	const pathname = usePathname();
	const permissions = usePermissions();
	const item = visibleItems(orgNav, permissions).find(
		(entry) => entry.url === "/settings",
	);
	if (!item) return null;
	return (
		<SidebarMenuItem>
			<NavButton item={item} state={sidebarState(pathname, item)} />
		</SidebarMenuItem>
	);
}
