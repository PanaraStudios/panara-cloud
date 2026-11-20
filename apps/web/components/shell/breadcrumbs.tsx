"use client";

import { api } from "@panara-cloud/backend/api";
import { useConvexAuth, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { EnvironmentMenu } from "@/components/project-pages/environment-switcher";
import { LOCAL_SERVER_NAME } from "@/components/servers/use-server";
import { ServiceIcon } from "@/components/service/service-icon";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	environmentUrl,
	isServiceKind,
	LOCAL_SERVER_ID,
	type NavLevel,
	navLevel,
	type ServiceRef,
	serverUrl,
	serviceNav,
	serviceUrl,
} from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { cn } from "@/lib/utils";

// Where a page under a project, a service or a server is: one line above its
// header ("Projects / storefront ▾ / production ▾ / web ▾"). A crumb's name
// links to that level; its ▾ switches to a sibling, keeping the open section
// where the sibling has it.

type Project = FunctionReturnType<typeof api.projects.all>[number];

type Option = {
	id: string;
	name: string;
	href: string;
	mark?: React.ReactNode;
};

const defaultEnvironment = (project: Project | undefined) =>
	project?.environments.find((item) => item.isDefault) ??
	project?.environments[0];

const switchButton =
	"-mr-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted data-popup-open:text-foreground";

function Separator({ className }: { className?: string }) {
	return (
		<li aria-hidden className={cn("text-muted-foreground/50", className)}>
			/
		</li>
	);
}

function Name({ children }: { children: string | undefined }) {
	return children ? (
		<span className="block max-w-[14rem] truncate">{children}</span>
	) : (
		<span className="block h-3 w-16 animate-pulse rounded bg-muted" />
	);
}

function CrumbLink({
	href,
	last = false,
	children,
}: {
	href: string;
	last?: boolean;
	children: React.ReactNode;
}) {
	return (
		<Link
			href={href}
			className={cn(
				"flex min-w-0 items-center gap-1.5 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
				last && "font-medium text-foreground",
			)}
		>
			{children}
		</Link>
	);
}

/** The ▾ after a crumb: its siblings as links. */
function Switcher({
	label,
	heading,
	value,
	options,
}: {
	/** "Switch project". */
	label: string;
	heading: string;
	value: string;
	options: Option[];
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger aria-label={label} className={switchButton}>
				<ChevronDownIcon className="size-3.5" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="min-w-52">
				<DropdownMenuGroup>
					<DropdownMenuLabel>{heading}</DropdownMenuLabel>
					{options.map((option) => (
						<DropdownMenuItem
							key={option.id}
							render={<Link href={option.href} />}
						>
							{option.mark}
							<span className="min-w-0 flex-1 truncate">{option.name}</span>
							<CheckIcon
								className={cn(
									"size-3.5 text-muted-foreground",
									option.id !== value && "invisible",
								)}
							/>
						</DropdownMenuItem>
					))}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function useProjects(enabled: boolean) {
	const { active } = useOrganization();
	const { isAuthenticated } = useConvexAuth();
	return useQuery(
		api.projects.all,
		enabled && isAuthenticated ? { organizationId: active.id } : "skip",
	);
}

/** The part of a service's path after its URL, without the id of a
    deployment (another service doesn't have it). */
const serviceSection = (pathname: string, service: ServiceRef) =>
	pathname
		.slice(serviceUrl(service).length)
		.replace(/^\/deployments\/.+$/, "/deployments");

function ProjectCrumbs({
	level,
}: {
	level: Extract<NavLevel, { level: "project" | "service" }>;
}) {
	const pathname = usePathname();
	const projects = useProjects(true);
	const project = projects?.find((item) => item.projectId === level.projectId);
	const service = level.level === "service" ? level : undefined;
	const environmentId = level.environmentId;
	const environments = project?.environments ?? [];
	const environment = environments.find(
		(item) => item.environmentId === environmentId,
	);
	const services = environment?.services ?? [];
	const current = service
		? services.find((item) => item.id === service.id)
		: undefined;
	const section = service ? serviceSection(pathname, service) : "";

	const projectHref = (target: Project | undefined) => {
		const first = defaultEnvironment(target);
		return target && first
			? environmentUrl(target.projectId, first.environmentId)
			: "/";
	};
	// Another environment's service of the same name and kind stands in for
	// the open one.
	const twinHref = (nextId: string) => {
		if (!service || !current) return undefined;
		const twin = environments
			.find((item) => item.environmentId === nextId)
			?.services.find(
				(item) => item.name === current.name && item.type === service.kind,
			);
		return twin
			? `${serviceUrl({ ...service, environmentId: nextId, id: twin.id })}${section}`
			: environmentUrl(service.projectId, nextId);
	};
	const serviceHref = (next: (typeof services)[number]) => {
		if (!service || !isServiceKind(next.type)) return "#";
		const target = { ...service, kind: next.type, id: next.id };
		const url = `${serviceUrl(target)}${section}`;
		const available = serviceNav(target).some(
			(item) =>
				section &&
				(item.url === url || item.children?.some((child) => child.url === url)),
		);
		return available ? url : serviceUrl(target);
	};

	return (
		<>
			<li className="max-md:hidden">
				<CrumbLink href="/">Projects</CrumbLink>
			</li>
			<Separator className="max-md:hidden" />
			<li className="flex min-w-0 items-center gap-0.5">
				<CrumbLink
					href={projectHref(project)}
					last={!environmentId && !service}
				>
					<Name>{project?.name}</Name>
				</CrumbLink>
				{projects && projects.length > 1 ? (
					<Switcher
						label="Switch project"
						heading="Projects"
						value={level.projectId}
						options={projects.map((item) => ({
							id: item.projectId,
							name: item.name,
							href: projectHref(item),
						}))}
					/>
				) : null}
			</li>
			{environmentId ? (
				<>
					<Separator className={cn(service && "max-md:hidden")} />
					<li
						className={cn(
							"flex min-w-0 items-center gap-0.5",
							service && "max-md:hidden",
						)}
					>
						<CrumbLink
							href={environmentUrl(level.projectId, environmentId)}
							last={!service}
						>
							<Name>{environment?.name}</Name>
						</CrumbLink>
						{environments.length > 1 ? (
							<EnvironmentMenu
								projectId={level.projectId}
								environmentId={environmentId}
								hrefFor={service ? twinHref : undefined}
								trigger={
									<button
										type="button"
										aria-label="Switch environment"
										className={switchButton}
									/>
								}
							>
								<ChevronDownIcon className="size-3.5" />
							</EnvironmentMenu>
						) : null}
					</li>
				</>
			) : null}
			{service ? (
				<>
					<Separator />
					<li className="flex min-w-0 items-center gap-0.5">
						<CrumbLink href={serviceUrl(service)} last>
							<ServiceIcon
								kind={service.kind}
								icon={current?.icon}
								className="size-3.5"
							/>
							<Name>{current?.name}</Name>
						</CrumbLink>
						{services.length > 1 ? (
							<Switcher
								label="Switch service"
								heading="Services"
								value={service.id}
								options={services.map((item) => ({
									id: item.id,
									name: item.name,
									href: serviceHref(item),
									mark: isServiceKind(item.type) ? (
										<ServiceIcon kind={item.type} icon={item.icon} />
									) : null,
								}))}
							/>
						) : null}
					</li>
				</>
			) : null}
		</>
	);
}

// The panel host (`local`) is listed only for the instance administrator,
// the only one who can open it.
function ServerCrumbs({ serverId }: { serverId: string }) {
	const pathname = usePathname();
	const { active } = useOrganization();
	const { isAuthenticated } = useConvexAuth();
	const servers = useQuery(
		api.servers.list,
		isAuthenticated ? { organizationId: active.id } : "skip",
	);
	const isInstanceAdmin = useQuery(
		api.infra.webServer.isInstanceAdmin,
		isAuthenticated ? {} : "skip",
	);
	// Only the tab carries over: a container or an image belongs to one server.
	const tab = pathname.slice(serverUrl(serverId).length).split("/")[1];
	const options = [
		...(isInstanceAdmin
			? [{ id: LOCAL_SERVER_ID, name: LOCAL_SERVER_NAME }]
			: []),
		...(servers ?? []).map((server) => ({
			id: server._id as string,
			name: server.name,
		})),
	].map((option) => ({ ...option, href: serverUrl(option.id, tab) }));
	const current = options.find((option) => option.id === serverId);
	return (
		<>
			<li className="max-md:hidden">
				<CrumbLink href="/servers">Servers</CrumbLink>
			</li>
			<Separator className="max-md:hidden" />
			<li className="flex min-w-0 items-center gap-0.5">
				<CrumbLink href={serverUrl(serverId)} last>
					<Name>{current?.name}</Name>
				</CrumbLink>
				{options.length > 1 ? (
					<Switcher
						label="Switch server"
						heading="Servers"
						value={serverId}
						options={options}
					/>
				) : null}
			</li>
		</>
	);
}

/** Whether a path is under a project, a service or a server, and so has a
    breadcrumb line. */
export const hasBreadcrumb = (pathname: string) =>
	["project", "service", "server"].includes(navLevel(pathname).level);

export function ContextBreadcrumb({ className }: { className?: string }) {
	const level = navLevel(usePathname());
	if (
		level.level !== "project" &&
		level.level !== "service" &&
		level.level !== "server"
	) {
		return null;
	}
	return (
		<nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
			<ol className="flex min-h-5 min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground leading-5">
				{level.level === "server" ? (
					<ServerCrumbs serverId={level.serverId} />
				) : (
					<ProjectCrumbs level={level} />
				)}
			</ol>
		</nav>
	);
}
