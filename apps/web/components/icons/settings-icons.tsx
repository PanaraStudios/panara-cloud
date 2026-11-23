"use client";

import { ArchiveIcon, PackageIcon, SparkleIcon } from "lucide-react";
import type { ComponentType } from "react";
import {
	DockerIcon,
	GiteaIcon,
	GithubIcon,
	GitlabIcon,
} from "@/components/icons/data-tools-icons";
import { CloudflareIcon } from "@/components/icons/dns-provider-icons";
import {
	AwsIcon,
	AzureIcon,
	ScalewayIcon,
} from "@/components/icons/vault-provider-icons";
import { cn } from "@/lib/utils";

interface Props {
	className?: string;
}

type Mark = ComponentType<Props>;

export const OpenAiIcon = ({ className }: Props) => (
	<svg
		viewBox="0 0 24 24"
		fill="currentColor"
		xmlns="http://www.w3.org/2000/svg"
		aria-hidden="true"
		className={className}
	>
		<path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
	</svg>
);

export const AnthropicIcon = ({ className }: Props) => (
	<svg
		viewBox="0 0 24 24"
		fill="currentColor"
		xmlns="http://www.w3.org/2000/svg"
		aria-hidden="true"
		className={className}
	>
		<path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
	</svg>
);

export const GeminiIcon = ({ className }: Props) => (
	<svg
		viewBox="0 0 24 24"
		xmlns="http://www.w3.org/2000/svg"
		aria-hidden="true"
		className={className}
	>
		<path
			fill="#4E82EE"
			d="M12 0c0 6.627-5.373 12-12 12 6.627 0 12 5.373 12 12 0-6.627 5.373-12 12-12-6.627 0-12-5.373-12-12Z"
		/>
	</svg>
);

export const MistralIcon = ({ className }: Props) => (
	<svg
		viewBox="0 -4 28 28"
		xmlns="http://www.w3.org/2000/svg"
		aria-hidden="true"
		className={className}
	>
		<path fill="#FFD800" d="M4 0h4v4H4zM20 0h4v4h-4z" />
		<path fill="#FFAF00" d="M4 4h8v4H4zM16 4h8v4h-8z" />
		<path fill="#FF8205" d="M4 8h20v4H4z" />
		<path fill="#FA500F" d="M4 12h4v4H4zM12 12h4v4h-4zM20 12h4v4h-4z" />
		<path fill="#E10500" d="M0 16h12v4H0zM16 16h12v4H16z" />
	</svg>
);

export const PerplexityIcon = ({ className }: Props) => (
	<svg
		viewBox="0 0 24 24"
		fill="#20808D"
		xmlns="http://www.w3.org/2000/svg"
		aria-hidden="true"
		className={className}
	>
		<path d="M22.3977 7.0896h-2.3106V.0676l-7.5094 6.3542V.1577h-1.1554v6.1966L4.4904 0v7.0896H1.6023v10.3976h2.8882V24l6.932-6.3591v6.2005h1.1554v-6.0469l6.9318 6.1807v-6.4879h2.8882V7.0896zm-3.4657-4.531v4.531h-5.355l5.355-4.531zm-13.2862.0676 4.8691 4.4634H5.6458V2.6262zM2.7576 16.332V8.245h7.8476l-6.1149 6.1147v1.9723H2.7576zm2.8882 5.0404v-3.8852h.0001v-2.6488l5.7763-5.7764v7.0111l-5.7764 5.2993zm12.7086.0248-5.7766-5.1509V9.0618l5.7766 5.7766v6.5588zm2.8882-5.0652h-1.733v-1.9723L13.3948 8.245h7.8478v8.087z" />
	</svg>
);

export const GoogleIcon = ({ className }: Props) => (
	<svg
		viewBox="0 0 24 24"
		xmlns="http://www.w3.org/2000/svg"
		aria-hidden="true"
		className={className}
	>
		<path
			fill="#4285F4"
			d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
		/>
		<path
			fill="#34A853"
			d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
		/>
		<path
			fill="#FBBC05"
			d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
		/>
		<path
			fill="#EA4335"
			d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
		/>
	</svg>
);

export const DigitalOceanIcon = ({ className }: Props) => (
	<svg
		viewBox="0 0 24 24"
		fill="#0080FF"
		xmlns="http://www.w3.org/2000/svg"
		aria-hidden="true"
		className={className}
	>
		<path d="M12.04 0C5.408-.02.005 5.37.005 11.992h4.638c0-4.923 4.882-8.731 10.064-6.855a6.95 6.95 0 014.147 4.148c1.889 5.177-1.924 10.055-6.84 10.064v-4.61H7.391v4.623h4.61V24c7.86 0 13.967-7.588 11.397-15.83-1.115-3.59-3.985-6.446-7.575-7.575A12.8 12.8 0 0012.039 0zM7.39 19.362H3.828v3.564H7.39zm-3.563 0v-2.978H.85v2.978z" />
	</svg>
);

export const HetznerIcon = ({ className }: Props) => (
	<svg
		viewBox="0 0 24 24"
		xmlns="http://www.w3.org/2000/svg"
		aria-hidden="true"
		className={className}
	>
		<rect width="24" height="24" rx="2.5" fill="#D50C2D" />
		<path fill="#fff" d="M4.6 4.9h3v5.6h8.8V4.9h3v14.2h-3v-5.7H7.6v5.7h-3z" />
	</svg>
);

/** opensend.cc's @ mark, re-drawn from its own logo component. */
export const OpensendIcon = ({ className }: Props) => (
	<svg
		viewBox="0 0 32 32"
		fill="none"
		stroke="currentColor"
		strokeWidth="2.7"
		strokeLinecap="round"
		strokeLinejoin="round"
		xmlns="http://www.w3.org/2000/svg"
		aria-hidden="true"
		className={className}
	>
		<circle cx="15.15" cy="14.2" r="3.65" />
		<path d="M18.8 10.5V18.15C18.8 21.55 16.55 24.35 12.85 24.35C7.85 24.35 5.15 20.35 5.15 14.7C5.15 8.85 9.45 4.7 15.35 4.7C21.25 4.7 25.5 9 25.5 15.1C25.5 17.85 24.35 20.05 22.15 21.35" />
	</svg>
);

/** A recognised product's logo, or the concept's glyph when it is unknown
    (`generic`), which is drawn muted like every other glyph. */
export type Brand = { Icon: Mark; generic?: boolean };

const hostOf = (value?: string | null) => {
	const raw = (value ?? "").trim().toLowerCase();
	if (!raw) return "";
	try {
		return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
	} catch {
		return raw.replace(/^[a-z]+:\/\//, "").split(/[/:]/)[0] ?? "";
	}
};

type HostRule = [domains: string[], Icon: Mark];

const byHost = (host: string, rules: HostRule[]) =>
	host
		? rules.find(([domains]) =>
				domains.some(
					(domain) => host === domain || host.endsWith(`.${domain}`),
				),
			)?.[1]
		: undefined;

const REGISTRY_HOSTS: HostRule[] = [
	[["docker.io", "docker.com"], DockerIcon],
	[["ghcr.io"], GithubIcon],
	[["gitlab.com"], GitlabIcon],
	[["amazonaws.com", "ecr.aws"], AwsIcon],
	[["gcr.io", "pkg.dev"], GoogleIcon],
	[["azurecr.io"], AzureIcon],
	[["digitalocean.com"], DigitalOceanIcon],
	[["scw.cloud"], ScalewayIcon],
];

/** The registry behind a host such as `ghcr.io`; empty means Docker Hub. */
export function registryBrand(registryUrl?: string | null): Brand {
	const host = hostOf(registryUrl);
	if (!host) return { Icon: DockerIcon };
	const Icon =
		byHost(host, REGISTRY_HOSTS) ??
		(host.includes("gitlab")
			? GitlabIcon
			: host.includes("gitea")
				? GiteaIcon
				: undefined);
	return Icon ? { Icon } : { Icon: PackageIcon, generic: true };
}

const S3_HOSTS: HostRule[] = [
	[["amazonaws.com"], AwsIcon],
	[["cloudflarestorage.com", "r2.dev"], CloudflareIcon],
	[["digitaloceanspaces.com"], DigitalOceanIcon],
	[["googleapis.com"], GoogleIcon],
	[["scw.cloud"], ScalewayIcon],
	[["your-objectstorage.com"], HetznerIcon],
];

const S3_PROVIDERS: Record<string, Mark> = {
	AWS: AwsIcon,
	Cloudflare: CloudflareIcon,
	DigitalOcean: DigitalOceanIcon,
	GCS: GoogleIcon,
	Scaleway: ScalewayIcon,
};

/** The storage provider behind a destination: its endpoint host says more
    than the provider picked in the form ("Other" covers many), so it wins. */
export function s3Brand(
	provider?: string | null,
	endpoint?: string | null,
): Brand {
	const Icon =
		byHost(hostOf(endpoint), S3_HOSTS) ??
		(provider ? S3_PROVIDERS[provider] : undefined);
	return Icon ? { Icon } : { Icon: ArchiveIcon, generic: true };
}

const AI_HOSTS: HostRule[] = [
	[["openai.azure.com", "cognitiveservices.azure.com"], AzureIcon],
	[["openai.com"], OpenAiIcon],
	[["anthropic.com"], AnthropicIcon],
	[["generativelanguage.googleapis.com"], GeminiIcon],
	[["googleapis.com"], GoogleIcon],
	[["mistral.ai"], MistralIcon],
	[["perplexity.ai"], PerplexityIcon],
	[["amazonaws.com"], AwsIcon],
	[["cloudflare.com"], CloudflareIcon],
	[["github.ai"], GithubIcon],
];

const AI_NAMES: [RegExp, Mark][] = [
	[/openai|chatgpt/, OpenAiIcon],
	[/anthropic|claude/, AnthropicIcon],
	[/gemini/, GeminiIcon],
	[/mistral/, MistralIcon],
	[/perplexity/, PerplexityIcon],
];

/** The model provider behind an API URL, falling back to its name. */
export function aiBrand(name?: string | null, apiUrl?: string | null): Brand {
	const label = (name ?? "").toLowerCase();
	const Icon =
		byHost(hostOf(apiUrl), AI_HOSTS) ??
		AI_NAMES.find(([pattern]) => pattern.test(label))?.[1];
	return Icon ? { Icon } : { Icon: SparkleIcon, generic: true };
}

/** A brand at text size, for select options and tabs. */
export function BrandIcon({
	brand,
	className,
}: {
	brand: Brand;
	className?: string;
}) {
	return (
		<span aria-hidden="true" className="inline-flex shrink-0">
			<brand.Icon
				className={cn(
					"size-4",
					brand.generic && "text-muted-foreground",
					className,
				)}
			/>
		</span>
	);
}

/** The one mark of a list row: a logo (or, with `glyph`, a muted lucide
    icon) in a 28px hairline tile, before the row's name. */
export function LogoTile({
	glyph,
	className,
	children,
}: {
	glyph?: boolean;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex size-7 shrink-0 items-center justify-center rounded-md border border-border",
				glyph ? "text-muted-foreground [&_svg]:size-4" : "[&_svg]:size-[18px]",
				className,
			)}
		>
			{children}
		</span>
	);
}

export function BrandTile({ brand }: { brand: Brand }) {
	return (
		<LogoTile glyph={brand.generic}>
			<brand.Icon />
		</LogoTile>
	);
}
