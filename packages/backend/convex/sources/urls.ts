import { ConvexError } from "convex/values";
import { assertAllowedEndpoint, errorMessage } from "../platform/lib/fetch";

export const DEFAULT_GITHUB_URL = "https://github.com";
export const DEFAULT_GITHUB_API_URL = "https://api.github.com";
export const DEFAULT_GITLAB_URL = "https://gitlab.com";
export const DEFAULT_GITEA_URL = "https://gitea.com";
export const BITBUCKET_API_URL = "https://api.bitbucket.org/2.0";

export const siteUrl = (): string => {
	const url = process.env.CONVEX_SITE_URL;
	if (!url) throw new ConvexError("CONVEX_SITE_URL is not configured");
	return url.replace(/\/+$/, "");
};

// The dashboard the OAuth callbacks send the browser back to.
export const dashboardUrl = (path: string): string =>
	`${(process.env.SITE_URL ?? "").replace(/\/+$/, "")}${path}`;

export const callbackUrls = () => ({
	githubSetup: `${siteUrl()}/sources/github/setup`,
	githubWebhook: `${siteUrl()}/webhooks/github`,
	gitlab: `${siteUrl()}/sources/gitlab/callback`,
	gitea: `${siteUrl()}/sources/gitea/callback`,
});

export const parseGithubBaseUrl = (
	githubUrl?: string | null,
): { url: string } | { error: string } => {
	const raw = githubUrl?.trim();
	if (!raw) return { url: DEFAULT_GITHUB_URL };
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
		? raw
		: `https://${raw}`;
	let parsed: URL;
	try {
		parsed = new URL(withScheme);
	} catch {
		return { error: `"${raw}" is not a valid URL` };
	}
	if (parsed.protocol !== "https:") {
		return { error: "Only https is supported for GitHub instances" };
	}
	// "acme.ghe.com." resolves like "acme.ghe.com" but would slip past the
	// hostname checks.
	const hostname = parsed.hostname.replace(/\.+$/, "");
	if (!hostname.includes(".")) {
		return { error: `"${hostname}" is not a fully qualified hostname` };
	}
	const port = parsed.port ? `:${parsed.port}` : "";
	return { url: `https://${hostname}${port}` };
};

export const normalizeGithubUrl = (githubUrl?: string | null): string => {
	const result = parseGithubBaseUrl(githubUrl);
	return "url" in result ? result.url : DEFAULT_GITHUB_URL;
};

export const deriveGithubApiUrl = (githubUrl?: string | null): string => {
	const { host } = new URL(normalizeGithubUrl(githubUrl));
	if (host === "github.com" || host === "www.github.com") {
		return DEFAULT_GITHUB_API_URL;
	}
	// Data residency tenants keep the api. prefix; GHES does not have one.
	if (host === "ghe.com" || host.endsWith(".ghe.com")) {
		return `https://api.${host}`;
	}
	return `https://${host}/api/v3`;
};

// GitLab / Gitea base URLs: http(s) only, no trailing slash. Basic-auth
// userinfo is allowed (some installs sit behind a proxy) and is split off by
// `splitBasicAuth` before use.
export const parseInstanceUrl = (raw: string, label: string): string => {
	let parsed: URL;
	try {
		parsed = new URL(raw.trim());
	} catch {
		throw new ConvexError(`${label} URL is not valid`);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new ConvexError(`${label} URL must use http or https`);
	}
	return parsed.toString().replace(/\/+$/, "");
};

// The backend calls the internal URL when there is one, so that is the host
// the outbound guard has to accept. Saving a host it refuses would only fail
// later, after the round trip through the provider's authorize page.
export const assertBackendCanReach = (
	instanceUrl: string,
	internalUrl: string | undefined,
) => {
	try {
		assertAllowedEndpoint(internalUrl || instanceUrl);
	} catch (error) {
		throw new ConvexError(errorMessage(error));
	}
};

export const splitBasicAuth = (
	url: string,
): { url: string; authorization?: string } => {
	const parsed = new URL(url);
	if (!parsed.username && !parsed.password) {
		return { url: url.replace(/\/+$/, "") };
	}
	const authorization = `Basic ${btoa(
		`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
	)}`;
	parsed.username = "";
	parsed.password = "";
	return { url: parsed.toString().replace(/\/+$/, ""), authorization };
};

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

export const assertRepoSegment = (value: string, label: string): string => {
	const trimmed = value.trim();
	if (!SEGMENT.test(trimmed) || trimmed === "." || trimmed === "..") {
		throw new ConvexError(`Invalid ${label}`);
	}
	return trimmed;
};

export const assertNamespacePath = (value: string): string => {
	const parts = value
		.trim()
		.replace(/^\/+|\/+$/g, "")
		.split("/");
	if (parts.length < 2) throw new ConvexError("Invalid GitLab project path");
	return parts
		.map((p) => assertRepoSegment(p, "GitLab project path"))
		.join("/");
};
