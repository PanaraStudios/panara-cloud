"use client";

import {
	ArrowLeftRightIcon,
	BanIcon,
	BoxIcon,
	CrownIcon,
	HardHatIcon,
	Link2Icon,
	type LucideIcon,
	type LucideProps,
	NetworkIcon,
	RadioIcon,
	RouterIcon,
	ServerIcon,
	WaypointsIcon,
} from "lucide-react";
import { type ComponentType, forwardRef } from "react";
import {
	DockerIcon,
	GiteaIcon,
	GitlabIcon,
	LibsqlIcon,
	MariadbIcon,
	MongodbIcon,
	MysqlIcon,
	PostgresqlIcon,
	RedisIcon,
} from "@/components/icons/data-tools-icons";
import { LogoMark } from "@/components/logo";
import { bundledIcons } from "@/lib/bundled-icons";
import { cn } from "@/lib/utils";

type IconComponent = ComponentType<{ className?: string }>;

const BUNDLED = new Map(bundledIcons.map((icon) => [icon.slug, icon]));

function luminance(hex: string) {
	const channel = (offset: number) => {
		const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

// A brand mark in its own colour. Marks whose colour is (near) black follow
// the text colour instead, and dim ones do so on the dark theme, so none
// disappears into the page.
function brandIcon(slug: string): LucideIcon {
	const icon = BUNDLED.get(slug);
	if (!icon) return BoxIcon;
	const light = luminance(icon.hex);
	const Brand = forwardRef<SVGSVGElement, LucideProps>(({ className }, ref) => (
		<svg
			ref={ref}
			viewBox="0 0 24 24"
			xmlns="http://www.w3.org/2000/svg"
			aria-hidden="true"
			fill={light < 0.02 ? "currentColor" : `#${icon.hex}`}
			className={cn(
				"shrink-0",
				light < 0.02 && "text-foreground",
				light >= 0.02 &&
					light < 0.1 &&
					"dark:fill-current dark:text-foreground",
				className,
			)}
		>
			<path d={icon.path} />
		</svg>
	));
	Brand.displayName = `${icon.title} icon`;
	return Brand;
}

// The existing multi-colour logos take only `className`; this lets them go
// where the kit asks for a lucide icon (Section, EmptyState).
function asLucide(Icon: IconComponent, name: string): LucideIcon {
	const Wrapped = forwardRef<SVGSVGElement, LucideProps>(
		({ className }, _ref) => <Icon className={cn("shrink-0", className)} />,
	);
	Wrapped.displayName = name;
	return Wrapped;
}

export const TraefikIcon = brandIcon("traefikproxy");
export const DockerMark = asLucide(DockerIcon, "Docker icon");
export const PanelMark = asLucide(
	({ className }) => <LogoMark decorative className={className} />,
	"Panara Cloud icon",
);

const IMAGE_BRANDS: [RegExp, LucideIcon][] = [
	[
		/^(postgres|postgresql|postgis|pgvector|timescaledb|pgbouncer)\b/,
		asLucide(PostgresqlIcon, "PostgreSQL icon"),
	],
	[/^mysql\b/, asLucide(MysqlIcon, "MySQL icon")],
	[/^mariadb\b/, asLucide(MariadbIcon, "MariaDB icon")],
	[/^mongo(db)?\b/, asLucide(MongodbIcon, "MongoDB icon")],
	[/^redis\b/, asLucide(RedisIcon, "Redis icon")],
	[/^(libsql|sqld)\b/, asLucide(LibsqlIcon, "libSQL icon")],
	[/^traefik\b/, TraefikIcon],
	[/^panara-cloud\b/, PanelMark],
	[/^nginx\b/, brandIcon("nginx")],
	[/^caddy\b/, brandIcon("caddy")],
	[/^(httpd|apache2?)$/, brandIcon("apache")],
	[/^node$/, brandIcon("nodedotjs")],
	[/^bun$/, brandIcon("bun")],
	[/^deno$/, brandIcon("deno")],
	[/^python$/, brandIcon("python")],
	[/^php$/, brandIcon("php")],
	[/^(golang|go)$/, brandIcon("go")],
	[/^rust$/, brandIcon("rust")],
	[/^ruby$/, brandIcon("ruby")],
	[/^elixir$/, brandIcon("elixir")],
	[/^(openjdk|eclipse-temurin|amazoncorretto)\b/, brandIcon("openjdk")],
	[/^alpine$/, brandIcon("alpinelinux")],
	[/^ubuntu$/, brandIcon("ubuntu")],
	[/^debian$/, brandIcon("debian")],
	[/^centos$/, brandIcon("centos")],
	[/^grafana\b/, brandIcon("grafana")],
	[/^prometheus\b/, brandIcon("prometheus")],
	[/^minio\b/, brandIcon("minio")],
	[/^rabbitmq\b/, brandIcon("rabbitmq")],
	[/^elasticsearch\b/, brandIcon("elasticsearch")],
	[/^opensearch\b/, brandIcon("opensearch")],
	[/^clickhouse\b/, brandIcon("clickhouse")],
	[/^influxdb\b/, brandIcon("influxdb")],
	[/^cassandra\b/, brandIcon("apachecassandra")],
	[/^(cp-)?kafka\b/, brandIcon("apachekafka")],
	[/^neo4j\b/, brandIcon("neo4j")],
	[/^cockroach(db)?\b/, brandIcon("cockroachlabs")],
	[/^couchbase\b/, brandIcon("couchbase")],
	[/^wordpress\b/, brandIcon("wordpress")],
	[/^ghost\b/, brandIcon("ghost")],
	[/^strapi\b/, brandIcon("strapi")],
	[/^directus\b/, brandIcon("directus")],
	[/^pocketbase\b/, brandIcon("pocketbase")],
	[/^appwrite\b/, brandIcon("appwrite")],
	[/^jenkins\b/, brandIcon("jenkins")],
	[/^vault\b/, brandIcon("vault")],
	[/^sentry\b/, brandIcon("sentry")],
	[/^gitea\b/, asLucide(GiteaIcon, "Gitea icon")],
	[/^gitlab\b/, asLucide(GitlabIcon, "GitLab icon")],
	[/^(docker|registry|buildkit)\b/, DockerMark],
];

/** The well-known product an image is, from its name:
    `ghcr.io/acme/postgres:16@sha256:…` → PostgreSQL. Only the start of the
    last path segment counts (`acme/api-redis-worker` stays unbranded), and
    runtimes must match whole (`node-exporter` isn't Node.js). */
export function imageBrandIcon(
	image: string | null | undefined,
): LucideIcon | null {
	if (!image) return null;
	const path = (image.split("@")[0] ?? "").toLowerCase();
	const lastSlash = path.lastIndexOf("/");
	const lastColon = path.lastIndexOf(":");
	const name = path.slice(
		lastSlash + 1,
		lastColon > lastSlash ? lastColon : undefined,
	);
	if (!name) return null;
	return IMAGE_BRANDS.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

/** The hairline tile a row's one mark sits in. */
export function MarkTile({
	icon: Icon,
	muted,
	className,
}: {
	icon: IconComponent;
	/** Dim the mark of a row that is itself dimmed (system, built-in). */
	muted?: boolean;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground",
				muted && "opacity-70",
				className,
			)}
		>
			<Icon className="size-[18px]" />
		</span>
	);
}

/** A container's or image's mark: the product's logo when the image name
    gives it away, the panel's mark for Panara Cloud's own containers, else
    the concept glyph. */
export function ImageMark({
	image,
	fallback = BoxIcon,
	system,
	muted,
}: {
	image: string | null | undefined;
	fallback?: LucideIcon;
	system?: boolean;
	muted?: boolean;
}) {
	return (
		<MarkTile
			icon={imageBrandIcon(image) ?? (system ? PanelMark : fallback)}
			muted={muted}
		/>
	);
}

/** The same lookup, without the tile, for a line of text. */
export function ImageGlyph({
	image,
	fallback = BoxIcon,
	system,
	className,
}: {
	image: string | null | undefined;
	fallback?: LucideIcon;
	system?: boolean;
	className?: string;
}) {
	const Icon = imageBrandIcon(image) ?? (system ? PanelMark : fallback);
	return (
		<Icon
			aria-hidden="true"
			className={cn("size-4 shrink-0 text-muted-foreground", className)}
		/>
	);
}

export function networkDriverIcon(driver: string): LucideIcon {
	switch (driver) {
		case "bridge":
			return Link2Icon;
		case "overlay":
			return WaypointsIcon;
		case "host":
			return ServerIcon;
		case "macvlan":
		case "ipvlan":
			return RouterIcon;
		case "null":
		case "none":
			return BanIcon;
		default:
			return NetworkIcon;
	}
}

export const protocolIcon = (protocol: string): LucideIcon =>
	protocol === "tcp"
		? ArrowLeftRightIcon
		: protocol === "udp"
			? RadioIcon
			: NetworkIcon;

export const swarmRoleIcon = (role: string): LucideIcon =>
	role === "manager" ? CrownIcon : HardHatIcon;

/** A small glyph before the value of a type column (driver, role). */
export function TypeLabel({
	icon: Icon,
	children,
	className,
}: {
	icon: IconComponent;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<span className={cn("inline-flex items-center gap-2", className)}>
			<Icon className="size-4 shrink-0 text-muted-foreground" />
			{children}
		</span>
	);
}
