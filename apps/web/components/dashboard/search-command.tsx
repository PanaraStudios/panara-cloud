"use client";

import { api } from "@panara-cloud/backend/api";
import { Command as CommandPrimitive, defaultFilter } from "cmdk";
import { useConvexAuth, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
	ArrowLeftRightIcon,
	ArrowUpIcon,
	CircuitBoard,
	FolderIcon,
	GlobeIcon,
	KeyboardIcon,
	ListChecksIcon,
	ListIcon,
	ScrollTextIcon,
	SearchIcon,
	ServerIcon,
	VariableIcon,
} from "lucide-react";
import React from "react";
import {
	SETUP_URL,
	usePanelSetupStatus,
} from "@/components/dashboard/setup/use-panel-setup";
import {
	MariadbIcon,
	MongodbIcon,
	MysqlIcon,
	PostgresqlIcon,
	RedisIcon,
} from "@/components/icons/data-tools-icons";
import { useServerStates } from "@/components/servers/use-server-states";
import { runtimeOf } from "@/components/service/service-context";
import { usePendingChanges } from "@/components/service/use-pending-changes";
import { NavigationKeys } from "@/components/shell/shortcuts-dialog";
import {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { OPEN_DEPLOY_REVIEW } from "@/lib/dashboard/events";
import {
	accountNav,
	activityNav,
	isVisible,
	LOCAL_SERVER_ID,
	type NavItem,
	navLevel,
	orgNav,
	serverNav,
	serverUrl,
	serviceNav,
	serviceUrl,
	settingsEntries,
} from "@/lib/navigation";
import { useIsInstanceAdmin, useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { usePathname, useRouter } from "@/lib/router";
import { serviceActionState } from "@/lib/service-actions";
import { StatusTooltip } from "../shared/status-tooltip";

type Project = FunctionReturnType<typeof api.projects.all>[number];

type SearchServices = Project["environments"][number]["services"][number] & {
	environmentId: string;
	environmentName: string;
};

const extractAllServicesFromProject = (project: Project): SearchServices[] =>
	project.environments.flatMap((environment) =>
		environment.services.map((service) => ({
			...service,
			environmentId: environment.environmentId,
			environmentName: environment.name,
		})),
	);

function PageItem({
	item,
	prefix,
	keywords = [],
	go,
}: {
	item: NavItem;
	prefix?: string;
	keywords?: string[];
	go: (href: string) => void;
}) {
	const title = prefix ? `${prefix} · ${item.title}` : item.title;
	return (
		<CommandItem
			value={title}
			keywords={[...keywords, ...(item.keywords ?? [])]}
			onSelect={() => go(item.url)}
		>
			<item.icon />
			{title}
			<NavigationKeys shortcut={item.shortcut} />
		</CommandItem>
	);
}

// opensend's command menu (⌘K): pages first, then the projects and
// services search. The shell owns the open state and the shortcut.
export const SearchCommand = ({
	open,
	onOpenChange,
	onShortcuts,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onShortcuts: () => void;
}) => {
	const router = useRouter();
	const [search, setSearch] = React.useState("");
	const { active } = useOrganization();
	// Signed-in session changes (password, 2FA) briefly clear Convex auth; this
	// is mounted on every page, so wait instead of failing.
	const { isAuthenticated } = useConvexAuth();
	const data = useQuery(
		api.projects.all,
		isAuthenticated && open ? { organizationId: active.id } : "skip",
	);
	const permissions = usePermissions();
	const instanceAdmin = useIsInstanceAdmin();
	const visible = (item: NavItem) =>
		isVisible(item, permissions, instanceAdmin);
	const level = navLevel(usePathname());
	const servers = useQuery(
		api.servers.list,
		isAuthenticated && open ? { organizationId: active.id } : "skip",
	);
	const isInstanceAdmin = useQuery(
		api.infra.webServer.isInstanceAdmin,
		isAuthenticated && open ? {} : "skip",
	);
	const panelSetup = usePanelSetupStatus(isAuthenticated && open);
	const serverItems =
		level.level === "server" ? serverNav(level.serverId).filter(visible) : [];
	const serverTargets = [
		...(isInstanceAdmin
			? [{ id: LOCAL_SERVER_ID, name: "Panara Cloud host" }]
			: []),
		...(servers ?? []).map((server) => ({
			id: server._id as string,
			name: server.name,
		})),
	];
	const serviceItems =
		level.level === "service"
			? serviceNav(level)
					.filter(visible)
					.flatMap((item) => [item, ...(item.children ?? []).filter(visible)])
			: [];

	const pathname = usePathname();
	const recent = useRecent(pathname);
	const projectOf = (projectId: string) =>
		data?.find((project) => project.projectId === projectId);
	const currentService =
		level.level === "service"
			? projectOf(level.projectId)
					?.environments.find(
						(environment) => environment.environmentId === level.environmentId,
					)
					?.services.find((service) => service.id === level.id)
			: undefined;
	const currentServer =
		level.level === "server"
			? serverTargets.find((server) => server.id === level.serverId)
			: undefined;
	const context =
		currentService?.name ??
		currentServer?.name ??
		(level.level === "project" ? projectOf(level.projectId)?.name : undefined);
	const pending = usePendingChanges(
		level.level === "service" ? level.kind : "application",
		level.level === "service" && open ? level.id : undefined,
	);
	const serverStates = useServerStates(open);
	const serviceActions = currentService
		? serviceActionState(currentService, runtimeOf(pending), {
				server: serverStates.get(currentService.serverId ?? ""),
			})
		: null;
	const actionsOnly = search.trimStart().startsWith(">");

	const setOpen = (next: boolean) => {
		if (!next) setSearch("");
		onOpenChange(next);
	};
	const go = (href: string) => {
		setOpen(false);
		router.push(href);
	};

	return (
		<CommandDialog
			open={open}
			onOpenChange={setOpen}
			title="Search"
			description="Jump to a page, project or service"
			className="sm:max-w-xl"
		>
			<Command
				filter={(value, query, keywords) =>
					defaultFilter(value, query.replace(/^\s*>\s*/, ""), keywords)
				}
			>
				<div className="flex items-center gap-2 border-b px-3">
					<SearchIcon className="size-4 shrink-0 text-muted-foreground" />
					{context ? (
						<span className="shrink-0 rounded-md border bg-muted px-1.5 py-0.5 font-medium text-xs">
							{context}
						</span>
					) : null}
					<CommandPrimitive.Input
						autoFocus
						placeholder="Search or run a command…"
						value={search}
						onValueChange={setSearch}
						className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
					/>
					<Kbd>esc</Kbd>
				</div>
				<CommandList className="max-h-[min(60vh,28rem)]">
					<CommandEmpty>No results found.</CommandEmpty>
					{level.level === "service" && currentService ? (
						<CommandGroup heading={`Actions for ${currentService.name}`}>
							{permissions.deployment.create ? (
								<CommandItem
									value={`deploy ${currentService.name}`}
									disabledReason={serviceActions?.deploy.reason}
									onSelect={() => {
										setOpen(false);
										const target = serviceUrl(level);
										if (pathname !== target) router.push(target);
										setTimeout(
											() => window.dispatchEvent(new Event(OPEN_DEPLOY_REVIEW)),
											pathname === target ? 0 : 600,
										);
									}}
								>
									<ArrowUpIcon />
									Deploy {currentService.name}
									{serviceActions?.deploy.enabled ? (
										<span className="grow text-right text-muted-foreground text-xs">
											{pending?.count
												? `${pending.count} ${pending.count === 1 ? "change" : "changes"} waiting`
												: "Review first"}
										</span>
									) : null}
								</CommandItem>
							) : null}
							<CommandItem
								value="view latest build log deployments"
								onSelect={() => go(serviceUrl(level, "deployments"))}
							>
								<ListIcon />
								View deployments and build logs
							</CommandItem>
							<CommandItem
								value="open live logs"
								onSelect={() => go(serviceUrl(level, "logs"))}
							>
								<ScrollTextIcon />
								Open live logs
							</CommandItem>
							<CommandItem
								value="edit variables environment"
								onSelect={() => go(serviceUrl(level, "settings/environment"))}
							>
								<VariableIcon />
								Edit variables
							</CommandItem>
							{(projectOf(level.projectId)?.environments.length ?? 0) > 1
								? projectOf(level.projectId)
										?.environments.filter(
											(environment) =>
												environment.environmentId !== level.environmentId,
										)
										.map((environment) => (
											<CommandItem
												key={environment.environmentId}
												value={`switch environment ${environment.name}`}
												onSelect={() =>
													go(
														`/projects/${level.projectId}/environment/${environment.environmentId}`,
													)
												}
											>
												<ArrowLeftRightIcon />
												Switch to {environment.name}
											</CommandItem>
										))
								: null}
						</CommandGroup>
					) : null}
					{!actionsOnly && recent.length > 0 && data ? (
						<CommandGroup heading="Recent">
							{recent
								.map((entry) => recentItem(entry, data, serverTargets))
								.filter((item) => item !== null)
								.map((item) => (
									<CommandItem
										key={item.href}
										value={`recent ${item.label}`}
										onSelect={() => go(item.href)}
									>
										{item.icon}
										<span className="truncate">{item.label}</span>
										<span className="grow text-right text-muted-foreground text-xs">
											{item.kind}
										</span>
									</CommandItem>
								))}
						</CommandGroup>
					) : null}
					{!actionsOnly && serviceItems.length > 0 && (
						<CommandGroup heading="This service">
							{serviceItems.map((item) => (
								<PageItem key={item.url} item={item} go={go} />
							))}
						</CommandGroup>
					)}
					{!actionsOnly && serverItems.length > 0 && (
						<CommandGroup heading="This server">
							{serverItems.map((item) => (
								<PageItem key={item.url} item={item} go={go} />
							))}
						</CommandGroup>
					)}
					{actionsOnly ? null : (
						<>
							<CommandGroup heading="Go to">
								<CommandItem
									onSelect={() => {
										setOpen(false);
										onShortcuts();
									}}
								>
									<KeyboardIcon />
									Keyboard shortcuts <Kbd className="ml-auto">?</Kbd>
								</CommandItem>
								{orgNav.filter(visible).map((item) => (
									<PageItem key={item.url} item={item} go={go} />
								))}
								{activityNav.filter(visible).map((item) => (
									<PageItem
										key={item.url}
										item={item}
										prefix="Activity"
										go={go}
									/>
								))}
								{settingsEntries
									.filter((entry) => visible(entry.item))
									.map((entry) => (
										<PageItem
											key={entry.item.url}
											item={entry.item}
											prefix={entry.prefix}
											keywords={["settings", entry.group]}
											go={go}
										/>
									))}
								{accountNav.map((item) => (
									<PageItem
										key={item.url}
										item={item}
										prefix="Account"
										go={go}
									/>
								))}
								{panelSetup?.isInstanceAdmin ? (
									<CommandItem
										value="Panel setup"
										keywords={["domain", "https", "installation"]}
										onSelect={() => go(SETUP_URL)}
									>
										<ListChecksIcon />
										Panel setup
									</CommandItem>
								) : null}
							</CommandGroup>
							<CommandSeparator />
							<CommandGroup heading="Projects">
								{data?.map((project) => {
									// Find default environment from accessible environments, or fall back to first accessible environment
									const defaultEnvironment =
										project.environments.find(
											(environment) => environment.isDefault,
										) || project?.environments?.[0];

									if (!defaultEnvironment) return null;

									return (
										<CommandItem
											key={project.projectId}
											onSelect={() => {
												router.push(
													`/projects/${project.projectId}/environment/${defaultEnvironment.environmentId}`,
												);
												setOpen(false);
											}}
										>
											<FolderIcon className="text-muted-foreground" />
											{project.name} / {defaultEnvironment.name}
										</CommandItem>
									);
								})}
							</CommandGroup>
							{serverTargets.length > 0 && permissions.server.read ? (
								<>
									<CommandSeparator />
									<CommandGroup heading="Servers">
										{serverTargets.map((server) => (
											<CommandItem
												key={server.id}
												value={`server ${server.name}`}
												onSelect={() => go(serverUrl(server.id))}
											>
												<ServerIcon className="text-muted-foreground" />
												{server.name}
											</CommandItem>
										))}
									</CommandGroup>
								</>
							) : null}
							<CommandSeparator />
							<CommandGroup heading="Services">
								{data?.map((project) => {
									const applications: SearchServices[] =
										extractAllServicesFromProject(project);
									return applications.map((application) => (
										<CommandItem
											key={application.id}
											onSelect={() => {
												router.push(
													`/projects/${project.projectId}/environment/${application.environmentId}/services/${application.type}/${application.id}`,
												);
												setOpen(false);
											}}
										>
											{application.type === "postgres" && (
												<PostgresqlIcon className="size-4" />
											)}
											{application.type === "redis" && (
												<RedisIcon className="size-4" />
											)}
											{application.type === "mariadb" && (
												<MariadbIcon className="size-4" />
											)}
											{application.type === "mongo" && (
												<MongodbIcon className="size-4" />
											)}
											{application.type === "mysql" && (
												<MysqlIcon className="size-4" />
											)}
											{application.type === "application" && (
												<GlobeIcon className="size-4" />
											)}
											{application.type === "compose" && (
												<CircuitBoard className="size-4" />
											)}
											<span className="grow">
												{project.name} / {application.environmentName} /{" "}
												{application.name}{" "}
												<div style={{ display: "none" }}>{application.id}</div>
											</span>
											<div>
												<StatusTooltip status={application.status} />
											</div>
										</CommandItem>
									));
								})}
							</CommandGroup>
						</>
					)}
				</CommandList>
				<div className="flex items-center gap-4 border-t px-4 py-2 text-muted-foreground text-xs">
					<span>↑↓ move</span>
					<span>↵ run</span>
					<span>esc close</span>
					<span className="ml-auto">Type &gt; for actions only</span>
				</div>
			</Command>
		</CommandDialog>
	);
};

type RecentEntry = { kind: "service" | "server"; path: string };
const RECENT_KEY = "panara-cloud-recent";

function readRecent(): RecentEntry[] {
	try {
		return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
	} catch {
		return [];
	}
}

/** The last services and servers this browser opened (palette "Recent"). */
function useRecent(pathname: string) {
	const [recent, setRecent] = React.useState<RecentEntry[]>([]);
	React.useEffect(() => {
		const level = navLevel(pathname);
		let list = readRecent();
		if (level.level === "service" || level.level === "server") {
			const path =
				level.level === "service"
					? serviceUrl(level)
					: serverUrl(level.serverId);
			list = [
				{ kind: level.level, path },
				...list.filter((entry) => entry.path !== path),
			].slice(0, 6);
			try {
				localStorage.setItem(RECENT_KEY, JSON.stringify(list));
			} catch {}
		}
		setRecent(list);
	}, [pathname]);
	return recent.filter((entry) => !pathname.startsWith(entry.path)).slice(0, 3);
}

function recentItem(
	entry: RecentEntry,
	projects: Project[],
	servers: { id: string; name: string }[],
) {
	const level = navLevel(entry.path);
	if (level.level === "server") {
		const server = servers.find((item) => item.id === level.serverId);
		return server
			? {
					href: entry.path,
					label: server.name,
					kind: "Server",
					icon: <ServerIcon className="text-muted-foreground" />,
				}
			: null;
	}
	if (level.level !== "service") return null;
	const project = projects.find((item) => item.projectId === level.projectId);
	const environment = project?.environments.find(
		(item) => item.environmentId === level.environmentId,
	);
	const service = environment?.services.find((item) => item.id === level.id);
	if (!project || !environment || !service) return null;
	return {
		href: entry.path,
		label: `${service.name} · ${project.name} / ${environment.name}`,
		kind:
			service.type === "application" || service.type === "compose"
				? "Service"
				: "Database",
		icon: <GlobeIcon className="text-muted-foreground" />,
	};
}
