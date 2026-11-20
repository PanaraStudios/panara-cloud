"use client";

import {
	ArchiveIcon,
	ArrowLeftRightIcon,
	BoxIcon,
	FileTextIcon,
	FolderSymlinkIcon,
	GitCommitHorizontalIcon,
	GlobeIcon,
	HammerIcon,
	HardDriveIcon,
	LockIcon,
	type LucideIcon,
	MousePointerClickIcon,
	PackageIcon,
	PanelsTopLeftIcon,
	PencilLineIcon,
	RadioIcon,
	RefreshCwIcon,
	SnowflakeIcon,
	TrainFrontIcon,
	Undo2Icon,
	UploadIcon,
} from "lucide-react";
import { type ComponentType, useState } from "react";
import {
	BitbucketIcon,
	DockerIcon,
	GiteaIcon,
	GithubIcon,
	GitIcon,
	GitlabIcon,
	LibsqlIcon,
	MariadbIcon,
	MongodbIcon,
	MysqlIcon,
	PostgresqlIcon,
	RedisIcon,
} from "@/components/icons/data-tools-icons";
import { AwsIcon, ScalewayIcon } from "@/components/icons/vault-provider-icons";
import { bundledIcons } from "@/lib/bundled-icons";
import { cn } from "@/lib/utils";

type Props = { className?: string };
type Mark = ComponentType<Props>;

const BUNDLED = new Map(bundledIcons.map((icon) => [icon.slug, icon]));

/** A simple-icons mark from the bundled set, in its own colour (near-black
    marks follow the text colour so they survive the dark theme). */
function bundled(slug: string): Mark {
	const icon = BUNDLED.get(slug);
	if (!icon) return BoxIcon;
	const dark = [0, 2, 4].every(
		(offset) => Number.parseInt(icon.hex.slice(offset, offset + 2), 16) < 0x30,
	);
	return ({ className }: Props) => (
		<svg
			viewBox="0 0 24 24"
			xmlns="http://www.w3.org/2000/svg"
			aria-hidden="true"
			fill={dark ? "currentColor" : `#${icon.hex}`}
			className={cn(dark && "text-foreground", className)}
		>
			<path d={icon.path} />
		</svg>
	);
}

/* The brand marks are drawn at different optical weights; a slot keeps every
   one of them the same box, centred, wherever a label follows. */
const slot = (className?: string) => cn("size-4 shrink-0", className);

const SOURCE_MARKS: Record<string, Mark> = {
	github: GithubIcon,
	gitlab: GitlabIcon,
	bitbucket: BitbucketIcon,
	gitea: GiteaIcon,
	git: GitIcon,
	docker: DockerIcon,
};

const SOURCE_GLYPHS: Record<string, LucideIcon> = {
	drop: UploadIcon,
	raw: PencilLineIcon,
};

/** Where a service's code or image comes from: the provider's logo, or a
    glyph for an upload or a file written in the panel. */
export function SourceIcon({
	source,
	className,
}: {
	source: string | null | undefined;
	className?: string;
}) {
	const Logo = source ? SOURCE_MARKS[source] : undefined;
	if (Logo) return <Logo className={slot(className)} />;
	const Glyph = (source && SOURCE_GLYPHS[source]) || GitCommitHorizontalIcon;
	return (
		<Glyph
			aria-hidden="true"
			className={cn(slot(className), "text-muted-foreground")}
		/>
	);
}

/** Git host of a custom Git URL (`git@github.com:acme/app.git`), so a plain
    Git source still shows its provider's logo. */
export function sourceOfGitUrl(url: string | null | undefined) {
	const host = url?.match(/(?:@|\/\/)([^/:]+)/)?.[1]?.toLowerCase();
	if (!host) return "git";
	if (host.includes("github")) return "github";
	if (host.includes("gitlab")) return "gitlab";
	if (host.includes("bitbucket")) return "bitbucket";
	if (host.includes("gitea") || host.includes("codeberg")) return "gitea";
	return "git";
}

const BUILD_GLYPHS: Record<string, LucideIcon> = {
	nixpacks: SnowflakeIcon,
	railpack: TrainFrontIcon,
	heroku_buildpacks: PackageIcon,
	paketo_buildpacks: PackageIcon,
	static: PanelsTopLeftIcon,
};

/** How the image is built: Docker's logo for a Dockerfile, a glyph for the
    builders that have no mark of their own here. */
export function BuildTypeIcon({
	type,
	className,
}: {
	type: string;
	className?: string;
}) {
	if (type === "dockerfile" || type === "docker")
		return <DockerIcon className={slot(className)} />;
	const Glyph = BUILD_GLYPHS[type] ?? HammerIcon;
	return (
		<Glyph
			aria-hidden="true"
			className={cn(slot(className), "text-muted-foreground")}
		/>
	);
}

const IMAGE_MARKS: [RegExp, Mark][] = [
	[
		/^(postgres|postgresql|postgis|pgvector|timescaledb|pgbouncer)\b/,
		PostgresqlIcon,
	],
	[/^mysql\b/, MysqlIcon],
	[/^mariadb\b/, MariadbIcon],
	[/^mongo(db)?\b/, MongodbIcon],
	[/^redis\b/, RedisIcon],
	[/^(libsql|sqld)\b/, LibsqlIcon],
	[/^gitea\b/, GiteaIcon],
	[/^gitlab\b/, GitlabIcon],
	[/^(docker|registry|buildkit)\b/, DockerIcon],
	...(
		[
			[/^traefik\b/, "traefikproxy"],
			[/^nginx\b/, "nginx"],
			[/^caddy\b/, "caddy"],
			[/^(httpd|apache2?)$/, "apache"],
			[/^node$/, "nodedotjs"],
			[/^bun$/, "bun"],
			[/^deno$/, "deno"],
			[/^python$/, "python"],
			[/^php$/, "php"],
			[/^(golang|go)$/, "go"],
			[/^rust$/, "rust"],
			[/^ruby$/, "ruby"],
			[/^elixir$/, "elixir"],
			[/^(openjdk|eclipse-temurin|amazoncorretto)\b/, "openjdk"],
			[/^grafana\b/, "grafana"],
			[/^prometheus\b/, "prometheus"],
			[/^minio\b/, "minio"],
			[/^rabbitmq\b/, "rabbitmq"],
			[/^elasticsearch\b/, "elasticsearch"],
			[/^opensearch\b/, "opensearch"],
			[/^clickhouse\b/, "clickhouse"],
			[/^influxdb\b/, "influxdb"],
			[/^(cp-)?kafka\b/, "apachekafka"],
			[/^neo4j\b/, "neo4j"],
			[/^wordpress\b/, "wordpress"],
			[/^ghost\b/, "ghost"],
			[/^strapi\b/, "strapi"],
			[/^directus\b/, "directus"],
			[/^pocketbase\b/, "pocketbase"],
			[/^appwrite\b/, "appwrite"],
			[/^supabase\b/, "supabase"],
			[/^vault\b/, "vault"],
		] as [RegExp, string][]
	).map(([pattern, slug]): [RegExp, Mark] => [pattern, bundled(slug)]),
];

/** The product a container image runs, from the last segment of its
    repository name (`ghcr.io/acme/postgres:16` → PostgreSQL). */
export function imageMark(image: string | null | undefined): Mark | null {
	if (!image) return null;
	const name =
		image.split("@")[0]?.split("/").at(-1)?.split(":")[0]?.toLowerCase() ?? "";
	return IMAGE_MARKS.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

/** A container's mark: the logo of a well-known image, else the container
    glyph. */
export function ImageIcon({
	image,
	className,
}: {
	image: string | null | undefined;
	className?: string;
}) {
	const Logo = imageMark(image);
	if (Logo) return <Logo className={slot(className)} />;
	return (
		<BoxIcon
			aria-hidden="true"
			className={cn(slot(className), "text-muted-foreground")}
		/>
	);
}

const TRIGGER_GLYPHS: Record<string, LucideIcon> = {
	Push: GitCommitHorizontalIcon,
	Manual: MousePointerClickIcon,
	Redeploy: RefreshCwIcon,
	Rebuild: HammerIcon,
	Rollback: Undo2Icon,
};

/** What started a deployment. A push shows the Git provider it came from. */
export function TriggerIcon({
	trigger,
	source,
	className,
}: {
	trigger: string;
	source?: string | null;
	className?: string;
}) {
	if (
		trigger === "Push" &&
		source &&
		SOURCE_MARKS[source] &&
		source !== "docker"
	)
		return <SourceIcon source={source} className={className} />;
	const Glyph = TRIGGER_GLYPHS[trigger] ?? MousePointerClickIcon;
	return (
		<Glyph
			aria-hidden="true"
			className={cn(slot(className), "text-muted-foreground")}
		/>
	);
}

/** A domain's mark, as a browser shows it: a lock when it is served over
    HTTPS, a globe when it is plain HTTP. */
export function DomainIcon({ https }: { https: boolean }) {
	const Icon = https ? LockIcon : GlobeIcon;
	return (
		<Icon
			aria-label={https ? "HTTPS" : "HTTP only"}
			className="size-4 shrink-0 text-muted-foreground"
		/>
	);
}

export const MOUNT_ICONS = {
	volume: HardDriveIcon,
	bind: FolderSymlinkIcon,
	file: FileTextIcon,
} as const satisfies Record<string, LucideIcon>;

export const PROTOCOL_ICONS = {
	tcp: ArrowLeftRightIcon,
	udp: RadioIcon,
} as const satisfies Record<string, LucideIcon>;

const DESTINATION_MARKS: [RegExp, Mark][] = [
	[/\baws\b|amazonaws\.com/, AwsIcon],
	[/cloudflare|r2\.dev/, bundled("cloudflare")],
	[/digitalocean/, bundled("digitalocean")],
	[/scaleway|scw\.cloud/, ScalewayIcon],
	[/minio/, bundled("minio")],
];

/** An S3 destination's provider logo, from its provider key or endpoint
    host; the storage glyph when it is not one drawn here. */
export function DestinationIcon({
	destination,
	className,
}: {
	destination:
		| { provider?: string | null; endpoint?: string | null }
		| null
		| undefined;
	className?: string;
}) {
	const hint =
		`${destination?.endpoint ?? ""} ${destination?.provider ?? ""}`.toLowerCase();
	const Logo = DESTINATION_MARKS.find(([pattern]) => pattern.test(hint))?.[1];
	if (Logo) return <Logo className={slot(className)} />;
	return (
		<ArchiveIcon
			aria-hidden="true"
			className={cn(slot(className), "text-muted-foreground")}
		/>
	);
}

/** The hairline tile around the mark of a table row's or a list item's
    primary cell, the same box as a `Monogram`. */
export function MarkTile({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground [&>img]:size-[18px] [&>svg]:size-[18px]",
				className,
			)}
		>
			{children}
		</span>
	);
}

/** Identity mark for something the user named (a project): its first letter
    on a neutral tile. */
export function Monogram({
	name,
	className,
}: {
	name: string;
	className?: string;
}) {
	const letter = name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? "·";
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex size-7 shrink-0 select-none items-center justify-center rounded-md border border-border bg-muted font-medium text-muted-foreground text-xs uppercase",
				className,
			)}
		>
			{letter}
		</span>
	);
}

/** A catalog logo (templates): the image, or the name's monogram while there
    is none or it fails to load. */
export function CatalogLogo({
	src,
	name,
	className,
}: {
	src: string | null | undefined;
	name: string;
	className?: string;
}) {
	const [failed, setFailed] = useState<string | null>(null);
	if (!src || failed === src)
		return <Monogram name={name} className={className} />;
	return (
		<img
			src={src}
			alt=""
			loading="lazy"
			decoding="async"
			onError={() => setFailed(src)}
			className={cn("size-7 shrink-0 rounded-md object-contain", className)}
		/>
	);
}
