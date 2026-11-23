import {
	ActivityIcon,
	ArchiveIcon,
	AtSignIcon,
	BellIcon,
	BlocksIcon,
	BoxIcon,
	BracesIcon,
	Building2Icon,
	CableIcon,
	ChartColumnIcon,
	CircleArrowUpIcon,
	ClockIcon,
	CodeIcon,
	ContainerIcon,
	CpuIcon,
	DatabaseBackupIcon,
	EthernetPortIcon,
	FileDiffIcon,
	FolderIcon,
	ForwardIcon,
	GaugeIcon,
	GitBranchIcon,
	GitPullRequestIcon,
	GlobeIcon,
	HardDriveIcon,
	KeyRoundIcon,
	LayersIcon,
	LayoutDashboardIcon,
	Link2Icon,
	ListChecksIcon,
	LockIcon,
	type LucideIcon,
	MicrochipIcon,
	MonitorIcon,
	NetworkIcon,
	PackageIcon,
	RocketIcon,
	RouteIcon,
	ScrollTextIcon,
	ServerIcon,
	SettingsIcon,
	ShieldCheckIcon,
	ShieldIcon,
	SignpostIcon,
	SlidersHorizontalIcon,
	SparkleIcon,
	SquareDashedIcon,
	SquareTerminalIcon,
	TagIcon,
	TriangleAlertIcon,
	UserIcon,
	UsersIcon,
	WrenchIcon,
} from "lucide-react";
import type { Permissions } from "@/lib/permissions";

// Single source of the app's navigation (see docs/design.md): the sidebar's
// items, the tabs of a project, a service, a server, Activity and Account,
// the pages of Settings, and the URL builders pages link with.

export type NavItem = {
	title: string;
	url: string;
	icon: LucideIcon;
	// Shown only when the member's permissions allow (hidden, never disabled).
	enabled?: (permissions: Permissions) => boolean;
	// About the installation, not the organization: instance administrators only.
	instanceAdmin?: boolean;
	// One plain line saying what the page is for.
	description?: string;
	// Other words people look for it by ("smtp" for Email).
	keywords?: string[];
	// The title alone is ambiguous outside its group ("Domain", "Backups").
	qualified?: boolean;
	// opensend's "G then letter" navigation shortcut.
	shortcut?: string;
	// Active only on an exact match (index pages whose children are siblings).
	exact?: boolean;
	// The item's own sections, for ⌘K.
	children?: NavItem[];
};

export type NavGroup = { label?: string; items: NavItem[] };

export const isVisible = (
	item: NavItem,
	permissions: Permissions,
	instanceAdmin = false,
) =>
	(!item.instanceAdmin || instanceAdmin) &&
	(!item.enabled || item.enabled(permissions));

export const visibleItems = (
	items: NavItem[],
	permissions: Permissions,
	instanceAdmin = false,
) => items.filter((item) => isVisible(item, permissions, instanceAdmin));

export function isActive(pathname: string, url: string, exact = false) {
	const path = url.split(/[?#]/)[0] || "/";
	if (path === "/" || exact) return pathname === path;
	return pathname === path || pathname.startsWith(`${path}/`);
}

/* Services */

export const DATABASE_KINDS = [
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"libsql",
] as const;
export const SERVICE_KINDS = [
	"application",
	"compose",
	...DATABASE_KINDS,
] as const;

export type DatabaseKind = (typeof DATABASE_KINDS)[number];
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export const isServiceKind = (value: string): value is ServiceKind =>
	(SERVICE_KINDS as readonly string[]).includes(value);
export const isDatabaseKind = (value: string): value is DatabaseKind =>
	(DATABASE_KINDS as readonly string[]).includes(value);

export const SERVICE_KIND_LABELS: Record<ServiceKind, string> = {
	application: "Application",
	compose: "Compose",
	postgres: "PostgreSQL",
	mysql: "MySQL",
	mariadb: "MariaDB",
	mongo: "MongoDB",
	redis: "Redis",
	libsql: "libSQL",
};

/** `serviceEvents` / `pendingChanges` target for a route kind. */
export const serviceTarget = (kind: ServiceKind, id: string) => ({
	kind: isDatabaseKind(kind)
		? ("database" as const)
		: (kind as "application" | "compose"),
	id,
});

export type ServiceRef = {
	projectId: string;
	environmentId: string;
	kind: ServiceKind;
	id: string;
};

export const projectUrl = (projectId: string) => `/projects/${projectId}`;
export const environmentUrl = (projectId: string, environmentId: string) =>
	`/projects/${projectId}/environment/${environmentId}`;

/** `/projects/p/environment/e/services/kind/id[/section]`. */
export const serviceUrl = (service: ServiceRef, section?: string) =>
	`${environmentUrl(service.projectId, service.environmentId)}/services/${service.kind}/${service.id}${section ? `/${section}` : ""}`;

export const serviceSettingsUrl = (service: ServiceRef, section = "general") =>
	serviceUrl(service, `settings/${section}`);

export const deploymentUrl = (service: ServiceRef, deploymentId: string) =>
	serviceUrl(service, `deployments/${deploymentId}`);

export type SettingsSection = {
	slug: string;
	title: string;
	icon: LucideIcon;
	kinds: "all" | readonly ("application" | "compose" | "database")[];
	enabled?: (permissions: Permissions) => boolean;
	// `serviceEvents` types whose pending changes put a dot on the section.
	events?: readonly string[];
};

const manage = (p: Permissions) => p.service.create;

export const SERVICE_SETTINGS_SECTIONS: readonly SettingsSection[] = [
	{
		slug: "general",
		title: "General",
		icon: SlidersHorizontalIcon,
		kinds: "all",
		events: [
			"config.general",
			"config.rename",
			"config.server",
			"config.source",
			"config.build",
			"config.password",
			"config.externalPort",
			"config.webhook",
		],
	},
	{
		slug: "environment",
		title: "Environment",
		icon: BracesIcon,
		kinds: "all",
		enabled: (p) => p.envVars.read,
		events: ["config.env"],
	},
	{
		slug: "domains",
		title: "Domains",
		icon: GlobeIcon,
		kinds: ["application", "compose"],
		enabled: (p) => p.domain.read,
		events: ["config.domains"],
	},
	{
		slug: "ports",
		title: "Ports",
		icon: EthernetPortIcon,
		kinds: ["application"],
		enabled: manage,
		events: ["config.ports"],
	},
	{
		slug: "volumes",
		title: "Volumes",
		icon: HardDriveIcon,
		kinds: "all",
		enabled: manage,
		events: ["config.mounts"],
	},
	{
		slug: "redirects",
		title: "Redirects",
		icon: SignpostIcon,
		kinds: ["application"],
		enabled: manage,
		events: ["config.redirects"],
	},
	{
		slug: "security",
		title: "Basic auth",
		icon: LockIcon,
		kinds: ["application"],
		enabled: manage,
		events: ["config.security"],
	},
	{
		slug: "resources",
		title: "Resources",
		icon: CpuIcon,
		kinds: ["application", "database"],
		enabled: manage,
		events: ["config.resources"],
	},
	{
		slug: "advanced",
		title: "Advanced",
		icon: WrenchIcon,
		kinds: "all",
		enabled: manage,
		events: ["config.advanced", "config.networks"],
	},
	{
		slug: "traefik",
		title: "Traefik",
		icon: RouteIcon,
		kinds: ["application"],
		enabled: manage,
		events: ["config.traefik"],
	},
	{
		slug: "previews",
		title: "Preview deployments",
		icon: GitPullRequestIcon,
		kinds: ["application"],
		enabled: (p) => p.deployment.read,
		events: ["config.previews"],
	},
	{
		slug: "patches",
		title: "Patches",
		icon: FileDiffIcon,
		kinds: ["application", "compose"],
		enabled: manage,
		events: ["config.patches"],
	},
	{
		slug: "schedules",
		title: "Schedules",
		icon: ClockIcon,
		kinds: ["application", "compose"],
		enabled: (p) => p.schedule.read,
		events: ["config.schedules"],
	},
	{
		slug: "volume-backups",
		title: "Volume backups",
		icon: ArchiveIcon,
		kinds: ["application", "compose"],
		enabled: (p) => p.volumeBackup.read,
		events: ["config.volumeBackups"],
	},
	{
		slug: "danger",
		title: "Danger zone",
		icon: TriangleAlertIcon,
		kinds: "all",
		enabled: (p) => p.service.create || p.service.delete,
		events: ["config.moved"],
	},
];

/* The Source tab of an application or a compose service: where the code,
   the image or the compose file comes from, and how it is built. A database
   has no source. */

export const SOURCE_SECTION = "source";
export const SOURCE_TAB = { title: "Source", icon: GitBranchIcon } as const;

// `serviceEvents` types whose changes are made on the Source tab.
const SOURCE_EVENTS: Record<"application" | "compose", readonly string[]> = {
	application: ["config.source", "config.build"],
	compose: ["config.source", "config.composeFile"],
};

export const hasSourceTab = (kind: ServiceKind) => !isDatabaseKind(kind);

/** The staged changes the Source tab shows and marks itself for. */
export const sourceTabEvents = (kind: ServiceKind): readonly string[] =>
	isDatabaseKind(kind)
		? []
		: SOURCE_EVENTS[kind === "compose" ? "compose" : "application"];

// Settings sections that became part of the Source tab, by the slug their
// old links carry.
const MOVED_SETTINGS_SECTIONS: Partial<Record<string, readonly string[]>> = {
	"compose-file": ["compose"],
	source: ["application", "compose"],
	build: ["application"],
};

/** Where an old `…/settings/<slug>` link leads now, as a section path under
    the service URL; undefined when the slug is still a settings section. */
export const movedSettingsSection = (kind: ServiceKind, slug: string) =>
	MOVED_SETTINGS_SECTIONS[slug]?.includes(serviceTarget(kind, "").kind)
		? SOURCE_SECTION
		: undefined;

/** The settings sections a kind has (before permissions). */
export const settingsSectionsFor = (kind: ServiceKind) => {
	const family = serviceTarget(kind, "").kind;
	return SERVICE_SETTINGS_SECTIONS.filter(
		(section) => section.kinds === "all" || section.kinds.includes(family),
	);
};

/** Settings section that shows a pending dot for a `serviceEvents` type;
    undefined for a change made on the Source tab. */
export const settingsSectionForEvent = (kind: ServiceKind, type: string) =>
	sourceTabEvents(kind).includes(type)
		? undefined
		: settingsSectionsFor(kind).find((section) =>
				section.events?.includes(type),
			)?.slug;

/** The `serviceEvents` types a settings section of this kind shows as
    waiting for a deploy: its own, without the ones the Source tab took. */
export const settingsSectionEvents = (
	kind: ServiceKind,
	section: SettingsSection,
) =>
	section.events?.filter((type) => !sourceTabEvents(kind).includes(type)) ?? [];

/** The page a staged change was made on (the Source tab or a settings
    section): its name, glyph and section path under the service URL. */
export function placeForEvent(kind: ServiceKind, type: string) {
	if (sourceTabEvents(kind).includes(type)) {
		return { ...SOURCE_TAB, section: SOURCE_SECTION };
	}
	const slug = settingsSectionForEvent(kind, type);
	const section = SERVICE_SETTINGS_SECTIONS.find((item) => item.slug === slug);
	return section
		? {
				title: section.title,
				icon: section.icon,
				section: `settings/${section.slug}`,
			}
		: undefined;
}

/** Every database has a Backups page; Redis's points at volume backups. */
export const hasBackups = (kind: ServiceKind) => isDatabaseKind(kind);

export function serviceNav(service: ServiceRef): NavItem[] {
	const url = (section?: string) => serviceUrl(service, section);
	const database = isDatabaseKind(service.kind);
	const items: NavItem[] = [
		{ title: "Overview", url: url(), icon: LayoutDashboardIcon, exact: true },
	];
	if (hasSourceTab(service.kind)) {
		items.push({
			title: SOURCE_TAB.title,
			url: url(SOURCE_SECTION),
			icon: SOURCE_TAB.icon,
			keywords: [
				"repository",
				"branch",
				"git",
				"image",
				"build type",
				"builder",
				"dockerfile",
				"compose file",
			],
		});
	}
	if (!database) {
		items.push({
			title: "Deployments",
			url: url("deployments"),
			icon: RocketIcon,
			enabled: (p) => p.deployment.read,
		});
	}
	if (hasBackups(service.kind)) {
		items.push({
			title: "Backups",
			url: url("backups"),
			icon: DatabaseBackupIcon,
			enabled: (p) => p.backup.read,
		});
	}
	items.push(
		{
			title: "Logs",
			url: url("logs"),
			icon: ScrollTextIcon,
			enabled: (p) => p.logs.read,
		},
		{
			title: "Metrics",
			url: url("metrics"),
			icon: GaugeIcon,
			enabled: (p) => p.monitoring.read,
		},
	);
	items.push({
		title: "Settings",
		url: url("settings"),
		icon: SettingsIcon,
		children: settingsSectionsFor(service.kind).map((section) => ({
			title: section.title,
			url: serviceSettingsUrl(service, section.slug),
			icon: section.icon,
			enabled: section.enabled,
		})),
	});
	return items;
}

/** Legacy `?tab=` value → section path under the service URL. */
export function sectionForLegacyTab(
	kind: ServiceKind,
	tab: string,
): string | undefined {
	const map: Record<string, string> = {
		general: "",
		deployments: isDatabaseKind(kind) ? "" : "deployments",
		logs: "logs",
		monitoring: "metrics",
		backups: hasBackups(kind) ? "backups" : "",
		environment: "settings/environment",
		domains: "settings/domains",
		"preview-deployments": "settings/previews",
		schedules: "settings/schedules",
		"volume-backups": "settings/volume-backups",
		volumeBackups: "settings/volume-backups",
		patches: "settings/patches",
		advanced: "settings/advanced",
		containers: "",
	};
	return map[tab];
}

/* The sidebar: these four items on every page. Projects and Servers list
   what they hold under them; Settings sits above the footer and opens the
   hub that lists the pages of `settingsNav`. */

export const orgNav: NavItem[] = [
	{ title: "Projects", url: "/", icon: FolderIcon, shortcut: "p" },
	{
		title: "Activity",
		url: "/activity",
		icon: ActivityIcon,
		shortcut: "a",
		enabled: (p) => p.deployment.read,
	},
	{
		title: "Servers",
		url: "/servers",
		icon: ServerIcon,
		shortcut: "r",
		enabled: (p) => p.server.read,
	},
	{
		title: "Settings",
		url: "/settings",
		icon: SettingsIcon,
		shortcut: "s",
		// Hidden when no Settings page is open to this member.
		enabled: (p) =>
			settingsNav.some((group) =>
				group.items.some((item) => isVisible(item, p)),
			),
	},
];

export function projectNav(
	projectId: string,
	environmentId: string,
): NavItem[] {
	const env = environmentUrl(projectId, environmentId);
	return [
		{ title: "Services", url: env, icon: BoxIcon, exact: true },
		{
			title: "Shared variables",
			url: `${env}/variables`,
			icon: BracesIcon,
			enabled: (p) => p.environmentEnvVars.read || p.projectEnvVars.read,
		},
		{
			title: "Settings",
			url: `${projectUrl(projectId)}/settings`,
			icon: SettingsIcon,
		},
	];
}

/* Servers. The panel host is the server with id `local`. */

export const LOCAL_SERVER_ID = "local";

export const serverUrl = (serverId: string, section?: string) =>
	`/servers/${serverId}${section ? `/${section}` : ""}`;

export const SERVER_SETTINGS_SECTIONS = [
	{
		slug: "setup",
		title: "Setup",
		icon: ListChecksIcon,
		description: "What is installed on the server, and the checks it passes.",
	},
	{
		slug: "security",
		title: "Security",
		icon: ShieldIcon,
		description: "Open ports, Fail2ban, SSH hardening and system updates.",
	},
	{
		slug: "docker",
		title: "Docker & builds",
		icon: ContainerIcon,
		description: "Clean-up, how many builds run at once, and Traefik.",
	},
	{
		slug: "gpu",
		title: "GPU",
		icon: MicrochipIcon,
		description: undefined,
	},
	{
		slug: "connection",
		title: "Connection",
		icon: CableIcon,
		description: "How Panara Cloud reaches the server over SSH.",
	},
] as const;

export type ServerSettingsSection =
	(typeof SERVER_SETTINGS_SECTIONS)[number]["slug"];

/**
 * `setUp: false` (a server that hasn't finished setup or can't run Docker
 * yet) keeps only Overview, Terminal and Settings.
 */
export function serverNav(
	serverId: string,
	{ setUp = true }: { setUp?: boolean } = {},
): NavItem[] {
	const url = (section?: string) => serverUrl(serverId, section);
	const items: (NavItem & { needsSetup?: boolean })[] = [
		{ title: "Overview", url: url(), icon: GaugeIcon, exact: true },
		{
			title: "Containers",
			url: url("containers"),
			icon: BoxIcon,
			enabled: (p) => p.docker.read,
			needsSetup: true,
		},
		{
			title: "Images",
			url: url("images"),
			icon: LayersIcon,
			enabled: (p) => p.docker.read,
			needsSetup: true,
		},
		{
			title: "Volumes",
			url: url("volumes"),
			icon: HardDriveIcon,
			enabled: (p) => p.docker.read,
			needsSetup: true,
		},
		{
			title: "Networks",
			url: url("networks"),
			icon: NetworkIcon,
			enabled: (p) => p.docker.read,
			needsSetup: true,
		},
		{
			title: "Traefik",
			url: url("traefik"),
			icon: GlobeIcon,
			enabled: (p) => p.traefikFiles.read,
			needsSetup: true,
		},
		{
			title: "Monitoring",
			url: url("monitoring"),
			icon: ChartColumnIcon,
			enabled: (p) => p.monitoring.read,
			needsSetup: true,
		},
		{
			title: "Terminal",
			url: url("terminal"),
			icon: SquareTerminalIcon,
			enabled: (p) => p.server.terminal,
		},
		{
			title: "Cluster",
			url: url("cluster"),
			icon: BlocksIcon,
			enabled: (p) => p.docker.read,
			needsSetup: true,
		},
		{
			title: "Sandboxes",
			url: url("sandboxes"),
			icon: SquareDashedIcon,
			enabled: (p) => p.sandbox.read,
			needsSetup: true,
		},
		{
			title: "Settings",
			url: url("settings"),
			icon: SlidersHorizontalIcon,
			enabled: (p) => p.server.create,
			children: SERVER_SETTINGS_SECTIONS.map((section) => ({
				title: section.title,
				url: url(`settings/${section.slug}`),
				icon: SlidersHorizontalIcon,
			})),
		},
	];
	return items
		.filter((item) => setUp || !item.needsSetup)
		.map(({ needsSetup: _, ...item }) => item);
}

/* Activity's tabs. */

/** Who may read the panel host's request log (Requests under Activity, the
    access log under a server's Traefik tab). The backend asks for the admin
    role there, so the screens neither offer it to nor ask it for anyone else. */
export const canReadRequests = (p: Permissions) =>
	p.docker.read && p.organization.update;

export const activityNav: NavItem[] = [
	{
		title: "Deployments",
		url: "/activity/deployments",
		icon: RocketIcon,
		enabled: (p) => p.deployment.read,
	},
	{
		title: "Schedules",
		url: "/activity/schedules",
		icon: ClockIcon,
		enabled: (p) => p.organization.update,
	},
	{
		title: "Requests",
		url: "/activity/requests",
		icon: ForwardIcon,
		enabled: canReadRequests,
	},
];

/* Settings: every page of the Settings area, grouped as its hub (`/settings`)
   lists them. The Panel group is about this installation. */

export const settingsNav: NavGroup[] = [
	{
		label: "Organization",
		items: [
			{
				title: "General",
				url: "/settings/general",
				icon: Building2Icon,
				description: "Your organization's name and logo.",
				keywords: ["organization", "rename"],
				qualified: true,
				enabled: (p) => p.organization.update,
			},
			{
				title: "Members",
				url: "/settings/members",
				icon: UsersIcon,
				description: "Who can sign in and what they can open.",
				keywords: ["users", "invite", "invitations", "roles", "permissions"],
				enabled: (p) => p.member.read,
			},
			{
				title: "Notifications",
				url: "/settings/notifications",
				icon: BellIcon,
				description: "Where deploy and backup results are sent.",
				keywords: ["slack", "discord", "telegram", "webhook", "alerts"],
				enabled: (p) => p.notification.read,
			},
			{
				title: "Tags",
				url: "/settings/tags",
				icon: TagIcon,
				description: "Labels to group and filter projects.",
				keywords: ["labels"],
				enabled: (p) => p.tag.read,
			},
			{
				title: "API keys",
				url: "/settings/api-keys",
				icon: CodeIcon,
				description: "Keys and reference for the HTTP API.",
				keywords: ["token", "mcp", "openapi", "ci", "scripts"],
				enabled: (p) => p.api.read,
			},
		],
	},
	{
		label: "Connections",
		items: [
			{
				title: "Git",
				url: "/settings/git",
				icon: GitBranchIcon,
				description: "GitHub, GitLab, Gitea and Bitbucket accounts.",
				keywords: ["repositories", "source", "provider"],
				enabled: (p) => p.gitProviders.read,
			},
			{
				title: "Registries",
				url: "/settings/registries",
				icon: PackageIcon,
				description: "Private registries to pull and push images.",
				keywords: ["docker", "images", "ghcr", "ecr"],
				enabled: (p) => p.registry.read,
			},
			{
				title: "S3 storage",
				url: "/settings/s3",
				icon: ArchiveIcon,
				description: "Buckets where backups are stored.",
				keywords: ["destinations", "bucket", "r2", "minio"],
				enabled: (p) => p.destination.read,
			},
			{
				title: "DNS",
				url: "/settings/dns",
				icon: GlobeIcon,
				description: "Accounts that create DNS records for you.",
				keywords: ["cloudflare", "route 53", "zones", "records"],
				enabled: (p) => p.dnsProvider.read,
			},
			{
				title: "Secrets",
				url: "/settings/secrets",
				icon: LockIcon,
				description: "Read variables from a secret manager.",
				keywords: ["vault", "environment"],
				enabled: (p) => p.vaultProvider.create,
			},
			{
				title: "AI providers",
				url: "/settings/ai",
				icon: SparkleIcon,
				description: "Models the setup assistant can use.",
				keywords: ["openai", "anthropic", "ollama", "assistant"],
				enabled: (p) => p.ai.read || p.ai.create || p.ai.update || p.ai.delete,
			},
			{
				title: "Logs & metrics",
				url: "/settings/logs-and-metrics",
				icon: ActivityIcon,
				description: "Send logs and metrics to another service.",
				keywords: ["telemetry", "monitoring", "cloudwatch", "export"],
				enabled: (p) => p.telemetryProvider.read,
			},
		],
	},
	{
		label: "Security",
		items: [
			{
				title: "SSH keys",
				url: "/settings/ssh-keys",
				icon: KeyRoundIcon,
				description: "Keys for servers and private repositories.",
				enabled: (p) => p.sshKeys.read,
			},
			{
				title: "Certificates",
				url: "/settings/certificates",
				icon: ShieldCheckIcon,
				description: "Your own TLS certificates for domains.",
				keywords: ["ssl", "https"],
				enabled: (p) => p.certificate.read,
			},
		],
	},
	{
		label: "Panel",
		items: [
			{
				title: "Domain",
				url: "/settings/domain",
				icon: Link2Icon,
				description: "The panel's address and HTTPS.",
				keywords: ["url", "ssl", "server ip", "port"],
				qualified: true,
				instanceAdmin: true,
			},
			{
				title: "Email",
				url: "/settings/email",
				icon: AtSignIcon,
				description: "How sign-in links and invitations are sent.",
				keywords: ["smtp", "resend", "mail"],
				qualified: true,
				instanceAdmin: true,
			},
			{
				title: "Updates",
				url: "/settings/updates",
				icon: CircleArrowUpIcon,
				description: "The installed version and new releases.",
				keywords: ["version", "upgrade", "reload", "queue"],
				qualified: true,
				instanceAdmin: true,
			},
			{
				title: "Backups",
				url: "/settings/backups",
				icon: DatabaseBackupIcon,
				description: "Backups of the panel's own data.",
				keywords: ["restore"],
				qualified: true,
				instanceAdmin: true,
			},
		],
	},
];

/** A Settings page as menus name it: its group first where the title alone
    could be anything ("Panel · Domain"), else "Settings · Members". */
export const settingsEntries = settingsNav.flatMap((group) =>
	group.items.map((item) => ({
		item,
		group: group.label ?? "Settings",
		prefix: item.qualified ? (group.label ?? "Settings") : "Settings",
	})),
);

/** A section of the old one-page General settings → the page it became. */
export const GENERAL_SECTION_URLS: Record<string, string> = {
	"panel-domain": "/settings/domain",
	updates: "/settings/updates",
	"panel-actions": "/settings/updates",
	"panel-backups": "/settings/backups",
};

/* Account (avatar menu) */

export const accountNav: NavItem[] = [
	{ title: "Profile", url: "/account/profile", icon: UserIcon },
	{ title: "Security", url: "/account/security", icon: ShieldIcon },
	{ title: "Sessions", url: "/account/sessions", icon: MonitorIcon },
];

/* Where a path is */

export type NavLevel =
	| { level: "org" }
	| { level: "project"; projectId: string; environmentId?: string }
	| ({ level: "service" } & ServiceRef)
	| { level: "server"; serverId: string }
	| { level: "activity" }
	| { level: "settings" }
	| { level: "account" };

/** The area a path is in. */
export function navLevel(pathname: string): NavLevel {
	const parts = pathname.split("/").filter(Boolean);
	if (parts[0] === "projects" && parts[1]) {
		const projectId = parts[1];
		const environmentId = parts[2] === "environment" ? parts[3] : undefined;
		if (
			environmentId &&
			parts[4] === "services" &&
			parts[5] &&
			parts[6] &&
			isServiceKind(parts[5])
		) {
			return {
				level: "service",
				projectId,
				environmentId,
				kind: parts[5],
				id: parts[6],
			};
		}
		return { level: "project", projectId, environmentId };
	}
	if (parts[0] === "servers" && parts[1] && parts[1] !== "new") {
		return { level: "server", serverId: parts[1] };
	}
	if (parts[0] === "activity") return { level: "activity" };
	if (parts[0] === "settings") return { level: "settings" };
	if (parts[0] === "account") return { level: "account" };
	return { level: "org" };
}

/** How a sidebar item relates to a path: filled ("current") when the page is
    the item's own, only marked ("ancestor") when the open page is one of the
    rows listed under it (a service, a server). */
export function sidebarState(
	pathname: string,
	item: NavItem,
): "current" | "ancestor" | undefined {
	const level = navLevel(pathname).level;
	if (item.url === "/") {
		if (level === "service" || level === "project") return "ancestor";
		return pathname === "/" || isActive(pathname, "/projects")
			? "current"
			: undefined;
	}
	if (!isActive(pathname, item.url)) return undefined;
	return item.url === "/servers" && level === "server" ? "ancestor" : "current";
}

/** The tab a path belongs to: the one whose URL is the longest prefix of it,
    so a page under a tab (a deployment, a container) keeps that tab. */
export function activeTab<T extends { href: string }>(
	pathname: string,
	tabs: readonly T[],
): T | undefined {
	let match: T | undefined;
	let length = -1;
	for (const tab of tabs) {
		const path = tab.href.split(/[?#]/)[0] ?? "";
		if (pathname !== path && !pathname.startsWith(`${path}/`)) continue;
		if (path.length > length) {
			match = tab;
			length = path.length;
		}
	}
	return match;
}
