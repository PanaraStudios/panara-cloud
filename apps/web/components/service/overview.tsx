"use client";

import { api } from "@panara-cloud/backend/api";
import { usePaginatedQuery, useQuery } from "convex/react";
import {
	ActivityIcon,
	AlertTriangleIcon,
	ArrowRightIcon,
	ArrowUpRightIcon,
	DatabaseBackupIcon,
	EthernetPortIcon,
	FileCodeIcon,
	FolderInputIcon,
	GaugeIcon,
	GitBranchIcon,
	GlobeIcon,
	HammerIcon,
	KeyRoundIcon,
	type LucideIcon,
	NetworkIcon,
	PencilIcon,
	PlayIcon,
	PlusIcon,
	RocketIcon,
	RotateCcwIcon,
	ServerIcon,
	SquareIcon,
	SquareTerminalIcon,
	Undo2Icon,
	WebhookIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { useJobLogs } from "@/components/dashboard/application/deployments/use-deployments";
import { parseLogs } from "@/components/dashboard/docker/logs/utils";
import { BuildTypeIcon, DomainIcon } from "@/components/icons/service-icons";
import { Button } from "@/components/ui/button";
import { Section, StatCell, StatStrip } from "@/components/ui-kit/primitives";
import {
	deploymentUrl,
	isDatabaseKind,
	SERVICE_SETTINGS_SECTIONS,
	SOURCE_SECTION,
	serviceSettingsUrl,
	serviceUrl,
} from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { ComposeOverview } from "./compose-overview";
import { DatabaseOverview } from "./database-overview";
import { useNotDeployed, useService } from "./service-context";
import { ChangeLines } from "./service-header";
import { formatBytes, formatRate, LineChart, useServiceStats } from "./stats";
import {
	type DeploymentRow,
	deploymentDuration,
	deploymentStatus,
	deploymentTitle,
	deploymentTrigger,
	formatDuration,
	shortSha,
	useServiceDeployments,
} from "./use-service-deployments";

/** The muted link at the right of a section title ("All deployments →"). */
export function MoreLink({
	href,
	children,
}: {
	href: string;
	children: string;
}) {
	return (
		<Link
			href={href}
			className="inline-flex shrink-0 items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
		>
			{children}
			<ArrowRightIcon className="size-3.5" />
		</Link>
	);
}

/** What a section says when it has nothing to list. */
export function SectionNote({ children }: { children: React.ReactNode }) {
	return <p className="py-3 text-muted-foreground text-sm">{children}</p>;
}

/** The anatomy every Overview shares: the fact strip, then the service's
    sections beside its activity. */
export function OverviewLayout({
	notice,
	facts,
	deployments,
	children,
}: {
	notice?: React.ReactNode;
	facts: React.ReactNode;
	deployments: DeploymentRow[] | undefined;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-8">
			{notice}
			{facts}
			<div className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
				<div className="flex min-w-0 flex-col gap-8 max-sm:has-[>.contents:only-child]:hidden">
					{children}
				</div>
				<aside className="flex min-w-0 flex-col">
					<EventTrail deployments={deployments} />
				</aside>
			</div>
		</div>
	);
}

const domainUrl = (domain: { https: boolean; host: string; path?: string }) =>
	`${domain.https ? "https" : "http"}://${domain.host}${domain.path && domain.path !== "/" ? domain.path : ""}`;

function useOwnerDomains() {
	const { service } = useService();
	const permissions = usePermissions();
	return useQuery(
		api.infra.domains.listByOwner,
		permissions.domain.read && service.family !== "database"
			? {
					owner: {
						kind: service.family as "application" | "compose",
						id: service.id,
					},
				}
			: "skip",
	);
}

/** Hosts with a staged domain change (added or edited, not deployed yet). */
function usePendingHosts() {
	const { pending } = useService();
	return useMemo(
		() =>
			new Set(
				(pending?.events ?? [])
					.filter((event) => event.type === "config.domains")
					.map((event) => event.details?.host)
					.filter((host): host is string => !!host),
			),
		[pending],
	);
}

function Domains() {
	const { service } = useService();
	const permissions = usePermissions();
	const domains = useOwnerDomains();
	const pendingHosts = usePendingHosts();
	if (!permissions.domain.read) return null;
	return (
		<Section
			title="Domains"
			icon={GlobeIcon}
			actions={
				permissions.service.create ? (
					<Button
						variant="outline"
						size="sm"
						nativeButton={false}
						render={
							<Link
								href={
									service.family === "application"
										? `${serviceSettingsUrl(service.ref, "domains")}?add=1`
										: serviceSettingsUrl(service.ref, "domains/new")
								}
							/>
						}
					>
						<PlusIcon data-icon="inline-start" />
						Add domain
					</Button>
				) : null
			}
		>
			{domains === undefined ? (
				<SectionNote>Loading…</SectionNote>
			) : domains.length === 0 ? (
				<SectionNote>
					No domains yet. Add one to reach {service.name} from the internet.
				</SectionNote>
			) : (
				<ul className="flex flex-col">
					{domains.map((domain) => {
						const url = domainUrl(domain);
						const staged = pendingHosts.has(domain.host);
						return (
							<li
								key={domain._id}
								className="flex min-h-11 items-center gap-2.5 border-border border-b py-2 text-sm"
							>
								<DomainIcon https={domain.https} />
								<a
									href={url}
									target="_blank"
									rel="noreferrer"
									className="min-w-0 flex-1 truncate font-medium hover:underline"
								>
									{url.replace(/^https?:\/\//, "")}
								</a>
								<span className="shrink-0 font-mono text-[13px] text-muted-foreground">
									<span className="font-sans">→</span>{" "}
									{domain.serviceName ? `${domain.serviceName}:` : ":"}
									{domain.port ?? 80}
								</span>
								<span
									className={cn(
										"flex w-44 shrink-0 items-center gap-1.5 whitespace-nowrap max-sm:hidden",
										staged ? "text-warning" : "text-muted-foreground",
									)}
								>
									<span
										className={cn(
											"size-1.5 rounded-full",
											staged
												? "bg-warning"
												: domain.https
													? "bg-success"
													: "bg-muted-foreground",
										)}
									/>
									{staged
										? "Pending deploy"
										: domain.https
											? domain.certificateType === "letsencrypt"
												? "HTTPS · Let's Encrypt"
												: "HTTPS"
											: "HTTP only"}
								</span>
							</li>
						);
					})}
				</ul>
			)}
		</Section>
	);
}

function DeploymentMeta({ row }: { row: DeploymentRow }) {
	const { service } = useService();
	const sha = shortSha(row);
	const branch =
		service.application?.branch ?? service.application?.customGitBranch;
	const duration = deploymentDuration(row);
	const parts: React.ReactNode[] = [];
	// A deployment that isn't the live one says how it ended: failed and
	// cancelled share nothing but a grey or red dot otherwise.
	if (!row.live)
		parts.push(<span key="status">{deploymentStatus(row).label}</span>);
	if (sha)
		parts.push(
			<span key="sha" className="font-mono text-[13px] text-foreground">
				{sha}
			</span>,
		);
	if (branch && row.commit)
		parts.push(
			<span key="branch" className="font-mono text-[13px]">
				{branch}
			</span>,
		);
	parts.push(<span key="trigger">{deploymentTrigger(row)}</span>);
	if (duration && row.status === "succeeded")
		parts.push(<span key="built">built in {duration}</span>);
	parts.push(
		<span key="at" title={new Date(row._creationTime).toLocaleString()}>
			{relativeTime(row.startedAt ?? row._creationTime)}
		</span>,
	);
	return (
		<p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-sm">
			{parts.map((part, i) => (
				<span key={(part as { key: string }).key} className="contents">
					{i > 0 ? <span aria-hidden="true">·</span> : null}
					{part}
				</span>
			))}
		</p>
	);
}

function LiveDeployment({
	deployments,
}: {
	deployments: DeploymentRow[] | undefined;
}) {
	const { service } = useService();
	const live = deployments?.find((row) => row.live);
	const latest = deployments?.[0];
	const row = live ?? latest;
	return (
		<Section
			title={live ? "Live deployment" : "Latest deployment"}
			icon={RocketIcon}
			actions={
				<MoreLink href={serviceUrl(service.ref, "deployments")}>
					All deployments
				</MoreLink>
			}
		>
			{deployments === undefined ? (
				<SectionNote>Loading…</SectionNote>
			) : !row ? (
				<SectionNote>
					Not deployed yet. Deploy to start it on{" "}
					{service.serverName ?? "the Panara Cloud host"}.
				</SectionNote>
			) : (
				<div className="flex flex-col gap-1.5 border-border border-b py-3">
					<div className="flex min-w-0 items-center gap-2.5">
						<span
							className={cn(
								"size-2 shrink-0 rounded-full",
								row.live
									? "bg-success"
									: row.status === "failed"
										? "bg-destructive"
										: "bg-muted-foreground",
							)}
						/>
						<Link
							href={deploymentUrl(service.ref, row._id)}
							className="min-w-0 flex-1 truncate font-medium text-sm hover:underline"
						>
							{deploymentTitle(row)}
						</Link>
						<Button
							variant="outline"
							size="sm"
							nativeButton={false}
							render={<Link href={deploymentUrl(service.ref, row._id)} />}
						>
							<SquareTerminalIcon data-icon="inline-start" />
							Build log
						</Button>
					</div>
					<div className="pl-[18px]">
						<DeploymentMeta row={row} />
					</div>
				</div>
			)}
		</Section>
	);
}

/** The running deployment: what it ships, its last log lines, a typical time. */
function NowDeploying({
	row,
	deployments,
}: {
	row: DeploymentRow;
	deployments: DeploymentRow[];
}) {
	const { service } = useService();
	const { text } = useJobLogs(row.jobId);
	const tail = useMemo(() => parseLogs(text).slice(-3), [text]);
	const typical = useMemo(() => {
		const durations = deployments
			.filter((d) => d.status === "succeeded" && d.startedAt && d.finishedAt)
			.slice(0, 5)
			.map((d) => (d.finishedAt ?? 0) - (d.startedAt ?? 0));
		if (durations.length === 0) return null;
		return formatDuration(
			durations.reduce((sum, ms) => sum + ms, 0) / durations.length,
		);
	}, [deployments]);
	return (
		<Section
			title="Now deploying"
			icon={RocketIcon}
			actions={
				<MoreLink href={deploymentUrl(service.ref, row._id)}>
					Open live build log
				</MoreLink>
			}
		>
			<div className="flex flex-col gap-3 pt-3">
				<div className="flex flex-col gap-1">
					<p className="truncate font-medium text-sm">{deploymentTitle(row)}</p>
					<DeploymentMeta row={row} />
				</div>
				<div className="h-1 overflow-hidden rounded-full bg-muted">
					<div className="h-full w-2/5 animate-pulse rounded-full bg-warning" />
				</div>
				<div className="rounded-lg border border-border bg-terminal px-4 py-3 font-mono text-[13px] text-terminal-foreground/90 leading-6">
					{tail.length === 0 ? (
						<p className="text-terminal-foreground/50">
							{row.status === "queued"
								? "Waiting for a build slot…"
								: "Starting…"}
						</p>
					) : (
						tail.map((line, i) => (
							<p key={i} className="flex gap-4 truncate">
								{line.timestamp ? (
									<span className="shrink-0 text-terminal-foreground/50">
										{line.timestamp.toLocaleTimeString(undefined, {
											hour12: false,
										})}
									</span>
								) : null}
								<span className="truncate">{line.message}</span>
							</p>
						))
					)}
				</div>
				<p className="text-muted-foreground text-sm">
					{typical ? `Typical build for ${service.name}: ${typical}. ` : ""}
					Settings edits made now queue as the next set of changes.
				</p>
			</div>
		</Section>
	);
}

function Resources() {
	const { service } = useService();
	const permissions = usePermissions();
	const notDeployed = useNotDeployed();
	const { points, loading } = useServiceStats(service, {
		enabled: permissions.monitoring.read && notDeployed === false,
	});
	if (!permissions.monitoring.read || service.family === "compose") return null;
	if (notDeployed !== false) return null;
	const last = points.at(-1);
	const memory = last ? formatBytes(last.memory) : null;
	const limit = last?.memoryLimit ? formatBytes(last.memoryLimit) : null;
	const cells = [
		{
			label: "CPU",
			value: last ? `${Math.round(last.cpu)}%` : "—",
			unit: "",
			values: points.map((p) => p.cpu),
		},
		{
			label: "Memory",
			value: memory ? `${memory.value} ${memory.unit}` : "—",
			unit: limit ? `of ${limit.value} ${limit.unit}` : "",
			values: points.map((p) => p.memory),
		},
		{
			label: "Network",
			value: last ? formatRate(last.netOut).split(" ")[0] : "—",
			unit: last ? `${formatRate(last.netOut).split(" ")[1]} out` : "",
			values: points.map((p) => p.netOut),
		},
	];
	return (
		<Section
			title="Resources"
			icon={GaugeIcon}
			hint="last hour"
			actions={
				<MoreLink href={serviceUrl(service.ref, "metrics")}>Metrics</MoreLink>
			}
		>
			{!loading && points.length < 2 ? (
				<SectionNote>
					No readings yet. They are collected while Metrics is open.
				</SectionNote>
			) : (
				<div className="grid grid-cols-3 divide-x divide-border border-border border-b max-sm:grid-cols-1 max-sm:divide-x-0 max-sm:divide-y">
					{cells.map((cell) => (
						<div
							key={cell.label}
							className="flex min-w-0 flex-col gap-1 px-4 py-3 first:pl-0 max-sm:px-0"
						>
							<span className="text-caption text-muted-foreground">
								{cell.label}
							</span>
							<span className="font-semibold text-xl tabular-nums">
								{cell.value}
								{cell.unit ? (
									<span className="ml-1 font-normal text-muted-foreground text-sm">
										{cell.unit}
									</span>
								) : null}
							</span>
							<LineChart
								label={`${cell.label} over the last hour`}
								series={[{ values: cell.values }]}
								height={28}
								grid={false}
							/>
						</div>
					))}
				</div>
			)}
		</Section>
	);
}

type TrailItem = {
	id: string;
	at: number;
	icon: LucideIcon;
	title: React.ReactNode;
	suffix?: string;
	body?: React.ReactNode;
	tone?: "destructive" | "warning" | "success";
	href?: string;
	actor?: string | null;
	pending?: boolean;
};

const AREA_TITLES: Record<string, string> = {
	"config.env": "Environment edited",
	"config.domains": "Domains edited",
	"config.ports": "Ports edited",
	"config.mounts": "Volumes edited",
	"config.redirects": "Redirects edited",
	"config.security": "Basic auth edited",
	"config.resources": "Resources edited",
	"config.build": "Build settings edited",
	"config.source": "Source changed",
	"config.composeFile": "Compose file edited",
	"config.patches": "Patches edited",
	"config.advanced": "Advanced settings edited",
	"config.networks": "Networks edited",
	"config.server": "Server changed",
	"config.externalPort": "External port changed",
	"config.rename": "Renamed",
	"config.general": "Details edited",
	"config.previews": "Preview deployments edited",
	"config.rollbacks": "Rollback settings edited",
	"config.webhook": "Deploy webhook regenerated",
	"config.traefik": "Traefik config edited",
	"config.schedules": "Schedules edited",
	"config.backups": "Backups edited",
	"config.volumeBackups": "Volume backups edited",
	"config.password": "Password changed",
	"config.moved": "Moved",
	"lifecycle.created": "Created",
	"lifecycle.start": "Started",
	"lifecycle.stop": "Stopped",
	"lifecycle.restart": "Restarted",
	"lifecycle.reload": "Reloaded",
	"lifecycle.transfer": "Moved to another server",
	"runtime.crashed": "Container crashed",
	"runtime.oomKilled": "Container OOM killed",
	"runtime.unhealthy": "Health check failing",
};

/* Events that have a glyph of their own. An edit to a settings section that
   is not listed here takes that section's icon from the navigation. */
const EVENT_ICONS: Partial<Record<string, LucideIcon>> = {
	"config.rename": PencilIcon,
	"config.externalPort": EthernetPortIcon,
	"config.build": HammerIcon,
	"config.source": GitBranchIcon,
	"config.composeFile": FileCodeIcon,
	"config.networks": NetworkIcon,
	"config.server": ServerIcon,
	"config.rollbacks": Undo2Icon,
	"config.webhook": WebhookIcon,
	"config.backups": DatabaseBackupIcon,
	"config.password": KeyRoundIcon,
	"config.moved": FolderInputIcon,
	"lifecycle.created": PlusIcon,
	"lifecycle.start": PlayIcon,
	"lifecycle.stop": SquareIcon,
	"lifecycle.restart": RotateCcwIcon,
	"lifecycle.reload": RotateCcwIcon,
	"lifecycle.transfer": ServerIcon,
};

function eventIcon(type: string): {
	icon: LucideIcon;
	tone?: TrailItem["tone"];
} {
	if (type === "runtime.oomKilled" || type === "runtime.crashed")
		return { icon: AlertTriangleIcon, tone: "destructive" };
	if (type.startsWith("runtime."))
		return { icon: AlertTriangleIcon, tone: "warning" };
	const icon =
		EVENT_ICONS[type] ??
		SERVICE_SETTINGS_SECTIONS.find((section) => section.events?.includes(type))
			?.icon;
	if (icon) return { icon };
	return { icon: type.startsWith("lifecycle.") ? PlayIcon : PencilIcon };
}

/** Member names for event actors (admins can list members). */
function useActorNames() {
	const { active } = useOrganization();
	const admin = active.role === "owner" || active.role === "admin";
	const members = useQuery(
		api.account.members,
		admin ? { organizationId: active.id } : "skip",
	);
	return useMemo(
		() =>
			new Map((members ?? []).map((member) => [member.userId, member.name])),
		[members],
	);
}

function TrailRow({ item }: { item: TrailItem }) {
	const toneClass =
		item.tone === "destructive"
			? "text-destructive"
			: item.tone === "warning"
				? "text-warning"
				: item.tone === "success"
					? "text-success"
					: "text-muted-foreground";
	const when = relativeTime(item.at);
	return (
		<li className="relative flex gap-3 pb-4 last:pb-0">
			<span
				aria-hidden="true"
				className="absolute top-7 bottom-0 left-[11px] w-px bg-border group-last/trail:hidden [li:last-child>&]:hidden"
			/>
			<span
				className={cn(
					"relative flex size-6 shrink-0 items-center justify-center rounded-full border bg-background",
					item.pending && "border-warning/40 text-warning",
					toneClass,
				)}
			>
				<item.icon className="size-3.5" />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5 text-sm">
				<p className="min-w-0">
					{item.href ? (
						<Link href={item.href} className="font-medium hover:underline">
							{item.title}
						</Link>
					) : (
						<span className="font-medium">{item.title}</span>
					)}
					{item.suffix ? (
						<span className="text-muted-foreground"> · {item.suffix}</span>
					) : null}
				</p>
				{item.body ? <div className="min-w-0">{item.body}</div> : null}
				<p className="text-muted-foreground text-xs">
					{item.actor ? `${item.actor} · ` : ""}
					<span title={new Date(item.at).toLocaleString()}>{when}</span>
				</p>
			</div>
		</li>
	);
}

export function EventTrail({
	deployments,
}: {
	deployments: DeploymentRow[] | undefined;
}) {
	const { service, pending } = useService();
	const names = useActorNames();
	const { results, status, loadMore } = usePaginatedQuery(
		api.serviceEvents.list,
		{ target: { kind: service.family, id: service.id } },
		{ initialNumItems: 30 },
	);
	const pendingById = useMemo(
		() => new Map((pending?.events ?? []).map((event) => [event._id, event])),
		[pending],
	);

	const { staged, earlier } = useMemo(() => {
		const oldestEvent =
			status === "Exhausted" ? 0 : (results.at(-1)?._creationTime ?? 0);
		const items: TrailItem[] = [
			...results.map((event): TrailItem => {
				const { icon, tone } = eventIcon(event.type);
				const stagedEvent = pendingById.get(event._id);
				const runtime = event.type.startsWith("runtime.");
				const title = AREA_TITLES[event.type] ?? event.summary;
				const details = event.details;
				const hasNames =
					(details?.changed?.length ?? 0) +
						(details?.added?.length ?? 0) +
						(details?.removed?.length ?? 0) >
					0;
				return {
					id: event._id,
					at: event._creationTime,
					icon,
					tone,
					title,
					suffix: runtime
						? details?.exitCode !== undefined
							? `exit code ${details.exitCode}${details.count && details.count > 1 ? ` · ${details.count} times` : ""}`
							: undefined
						: stagedEvent &&
								stagedEvent.action !== "reload" &&
								stagedEvent.action !== "deploy"
							? `needs ${stagedEvent.action}`
							: undefined,
					body: runtime ? (
						<p className="text-muted-foreground">
							{event.type === "runtime.oomKilled"
								? "Restarted automatically · "
								: ""}
							<Link
								href={serviceUrl(service.ref, "logs")}
								className="hover:text-foreground hover:underline"
							>
								View logs
							</Link>
						</p>
					) : hasNames && stagedEvent ? (
						<ChangeLines event={stagedEvent} />
					) : title !== event.summary ? (
						<p className="text-muted-foreground">{event.summary}</p>
					) : null,
					actor: event.actorId ? (names.get(event.actorId) ?? null) : null,
					pending: stagedEvent !== undefined,
				};
			}),
			// Deployments older than the loaded events wait for "Load more".
			...(deployments ?? [])
				.filter((row) => row._creationTime >= oldestEvent)
				.map((row): TrailItem => {
					const sha = shortSha(row);
					const ok = row.status === "succeeded";
					return {
						id: row._id,
						at: row._creationTime,
						icon:
							deploymentTrigger(row) === "Rollback" ? Undo2Icon : RocketIcon,
						tone: ok
							? "success"
							: row.status === "failed"
								? "destructive"
								: undefined,
						title: (
							<>
								Deployment{" "}
								{sha ? (
									<span className="font-mono text-[13px]">{sha}</span>
								) : null}{" "}
								{row.live
									? "is live"
									: ok
										? "succeeded"
										: row.status === "failed"
											? "failed"
											: row.status === "cancelled"
												? "cancelled"
												: "started"}
							</>
						),
						body: (
							<p className="truncate text-muted-foreground">
								{deploymentTrigger(row)} · {deploymentTitle(row)}
							</p>
						),
						href: deploymentUrl(service.ref, row._id),
					};
				}),
		].sort((a, b) => b.at - a.at);
		return {
			staged: items.filter((item) => item.pending),
			earlier: items.filter((item) => !item.pending),
		};
	}, [results, status, deployments, pendingById, service.ref, names]);

	return (
		<Section title="Activity" icon={ActivityIcon}>
			{status === "LoadingFirstPage" ? (
				<SectionNote>Loading…</SectionNote>
			) : staged.length + earlier.length === 0 ? (
				<SectionNote>
					Nothing yet. Deploys, setting changes, restarts and crashes show up
					here.
				</SectionNote>
			) : (
				<div className="flex flex-col gap-5 pt-4">
					{staged.length > 0 ? (
						<section className="flex flex-col gap-3">
							<div className="flex items-center justify-between">
								<h3 className="flex items-center gap-1.5 text-caption text-warning">
									<span className="size-1.5 rounded-full bg-warning" />
									Not applied yet · {staged.length}
								</h3>
								<Button
									variant="ghost"
									size="xs"
									className="-mr-2 text-muted-foreground"
									onClick={() =>
										window.dispatchEvent(new Event("service:review-changes"))
									}
								>
									Review
								</Button>
							</div>
							<ol className="flex flex-col">
								{staged.map((item) => (
									<TrailRow key={item.id} item={item} />
								))}
							</ol>
						</section>
					) : null}
					{earlier.length > 0 ? (
						<section className="flex flex-col gap-3">
							<h3 className="text-caption text-muted-foreground">
								{staged.length > 0 ? "Earlier" : "Recent"}
							</h3>
							<ol className="flex flex-col">
								{earlier.map((item) => (
									<TrailRow key={item.id} item={item} />
								))}
							</ol>
						</section>
					) : null}
					{status === "CanLoadMore" ? (
						<Button
							variant="ghost"
							size="sm"
							className="w-fit"
							onClick={() => loadMore(30)}
						>
							Load more
						</Button>
					) : null}
				</div>
			)}
		</Section>
	);
}

const OOM_WINDOW_MS = 7 * 24 * 3600 * 1000;

/** After OOM kills: a warning with the memory limit and where to raise it. */
function MemoryWarning() {
	const { service } = useService();
	const permissions = usePermissions();
	const { results } = usePaginatedQuery(
		api.serviceEvents.list,
		{ target: { kind: service.family, id: service.id } },
		{ initialNumItems: 30 },
	);
	const kills = results.filter(
		(event) =>
			event.type === "runtime.oomKilled" &&
			Date.now() - (event.details?.lastAt ?? event._creationTime) <
				OOM_WINDOW_MS,
	);
	if (kills.length === 0) return null;
	const count = kills.reduce(
		(sum, event) => sum + (event.details?.count ?? 1),
		0,
	);
	const latest = kills[0];
	const limit =
		service.application?.memoryLimit ?? service.database?.memoryLimit;
	const limitBytes = limit ? Number(limit) : 0;
	const limitLabel = limitBytes
		? (() => {
				const f = formatBytes(limitBytes);
				return `${f.value} ${f.unit}`;
			})()
		: null;
	return (
		<div className="flex flex-col gap-3 rounded-xl border border-border px-4 py-3 text-sm sm:flex-row sm:items-center">
			<AlertTriangleIcon className="size-4 shrink-0 text-warning max-sm:hidden" />
			<p className="min-w-0 flex-1">
				<span className="font-medium">
					{service.name} ran out of memory
					{count > 1 ? ` ${count} times` : ""}
				</span>{" "}
				<span className="text-muted-foreground">
					· last{" "}
					{relativeTime(
						latest?.details?.lastAt ?? latest?._creationTime ?? Date.now(),
					)}
					{limitLabel ? ` · limit ${limitLabel}` : " · no memory limit set"}.
					The container was killed and restarted.
				</span>
			</p>
			{permissions.service.create && service.family !== "compose" ? (
				<Button
					variant="outline"
					size="sm"
					nativeButton={false}
					render={<Link href={serviceSettingsUrl(service.ref, "resources")} />}
				>
					{limitLabel ? "Raise the limit" : "Set a limit"}
				</Button>
			) : null}
		</div>
	);
}

/** The application's key facts, as the strip under its header. */
function Facts({ deployments }: { deployments: DeploymentRow[] | undefined }) {
	const { service } = useService();
	const domains = useOwnerDomains();
	const live = deployments?.find((row) => row.live);
	const domain = domains?.[0];
	const pendingHosts = usePendingHosts();
	const permissions = usePermissions();
	const stats = useServiceStats(service, {
		enabled: permissions.monitoring.read,
	});
	const app = service.application;
	const facts: {
		label: string;
		value: React.ReactNode;
		mobile?: boolean;
	}[] = [];
	if (domain) {
		const url = domainUrl(domain);
		facts.push({
			label: "URL",
			value: (
				<a
					href={url}
					target="_blank"
					rel="noreferrer"
					className="inline-flex min-w-0 items-center gap-1 self-center hover:underline"
				>
					<span className="truncate">{domain.host}</span>
					<ArrowUpRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
				</a>
			),
		});
	}
	const sha = shortSha(live);
	facts.push({
		label: "Live deployment",
		value: live ? (
			<Link
				href={deploymentUrl(service.ref, live._id)}
				className="truncate hover:underline"
			>
				{sha ? <span className="font-mono text-[13px]">{sha}</span> : null}
				{sha ? " · " : ""}
				{relativeTime(live.startedAt ?? live._creationTime)}
			</Link>
		) : (
			<span className={FACT_MUTED}>None yet</span>
		),
	});
	if (app) {
		const duration = live ? deploymentDuration(live) : null;
		facts.push({
			label: "Build",
			value: (
				<>
					<Link
						href={serviceUrl(service.ref, SOURCE_SECTION)}
						className="inline-flex min-w-0 items-center gap-1.5 hover:underline"
					>
						<BuildTypeIcon
							type={app.sourceType === "docker" ? "docker" : app.buildType}
							className="self-center"
						/>
						<span className="truncate">
							{app.sourceType === "docker"
								? "Docker image"
								: (BUILD_LABELS[app.buildType] ?? app.buildType)}
						</span>
					</Link>
					{duration ? <span className={FACT_MUTED}>{duration}</span> : null}
				</>
			),
		});
	}
	facts.push({
		label: "Server",
		value: (
			<>
				<span className="truncate">
					{service.serverName ?? "Panara Cloud host"}
				</span>
				{app?.server?.ipAddress ? (
					<span className="truncate font-mono font-normal text-[13px] text-muted-foreground">
						{app.server.ipAddress}
					</span>
				) : null}
			</>
		),
	});
	if (app) {
		const cpu = app.cpuLimit ? Number(app.cpuLimit) / 1e9 : null;
		const memory = app.memoryLimit
			? formatBytes(Number(app.memoryLimit))
			: null;
		const limits = [
			cpu ? `${cpu} vCPU` : null,
			memory ? `${memory.value} ${memory.unit}` : null,
		].filter(Boolean);
		facts.push({
			label: "Replicas",
			value: (
				<>
					<span className="tabular-nums">{app.replicas ?? 1}</span>
					{limits.length > 0 ? (
						<span className={cn("truncate", FACT_MUTED)}>
							{limits.join(" · ")}
						</span>
					) : null}
				</>
			),
		});
	}
	// Phones get the gist of the blocks they don't show.
	const last = stats.points.at(-1);
	if (last) {
		const memory = formatBytes(last.memory);
		facts.push({
			label: "CPU · Memory",
			value: `${Math.round(last.cpu)}% · ${memory.value} ${memory.unit}`,
			mobile: true,
		});
	}
	if (domains && domains.length > 0) {
		const staged = domains.filter((d) => pendingHosts.has(d.host)).length;
		facts.push({
			label: "Domains",
			value: `${domains.length}${staged ? ` · ${staged} pending deploy` : ""}`,
			mobile: true,
		});
	}
	// Between `sm` and `lg` the phone-only cells are gone, so the last of the
	// others can end up alone in its row.
	const wide = facts.filter((fact) => !fact.mobile);
	const lastWide = wide.length % 2 === 1 ? wide.at(-1) : undefined;
	return (
		<StatStrip className={STRIP_ODD_LAST}>
			{facts.map((fact) => (
				<StatCell
					key={fact.label}
					label={fact.label}
					className={cn(
						fact.mobile && "sm:hidden",
						fact === lastWide && "sm:max-lg:col-span-2",
					)}
				>
					{fact.value}
				</StatCell>
			))}
		</StatStrip>
	);
}

/** The quieter second half of a fact ("Nixpacks · 42s"). */
export const FACT_MUTED = "font-normal text-muted-foreground";

/** For a `StatStrip` below `lg`, where cells sit two per row: a last cell
    left alone in its row takes the whole row, so its top rule does too. */
export const STRIP_ODD_LAST =
	"max-lg:[&>*:last-child:nth-child(odd)]:col-span-2";

const BUILD_LABELS: Record<string, string> = {
	dockerfile: "Dockerfile",
	nixpacks: "Nixpacks",
	railpack: "Railpack",
	heroku_buildpacks: "Heroku buildpacks",
	paketo_buildpacks: "Paketo buildpacks",
	static: "Static",
};

export function ServiceOverview() {
	const { service } = useService();
	if (isDatabaseKind(service.kind)) return <DatabaseOverview />;
	if (service.kind === "compose") return <ComposeOverview />;
	return <ApplicationOverview />;
}

function ApplicationOverview() {
	const { service } = useService();
	const deployments = useServiceDeployments(service);
	const active = deployments?.find(
		(row) => row.status === "running" || row.status === "queued",
	);
	return (
		<OverviewLayout
			notice={<MemoryWarning />}
			facts={<Facts deployments={deployments} />}
			deployments={deployments}
		>
			{active && deployments ? (
				<NowDeploying row={active} deployments={deployments} />
			) : null}
			<div className="contents max-sm:hidden">
				<LiveDeployment deployments={deployments} />
				<Domains />
				<Resources />
			</div>
		</OverviewLayout>
	);
}
