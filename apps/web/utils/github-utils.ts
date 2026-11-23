// utils/github-utils.ts
// This file contains client-safe utilities for GitHub integration.
// Mirrors parseGithubBaseUrl in packages/backend/convex/sources/urls.ts, which
// the web app does not import; keep the two in step.

export const DEFAULT_GITHUB_URL = "https://github.com";

interface ResolvedGithubBaseUrl {
	baseUrl: string;
	error?: string;
}

export const resolveGithubBaseUrl = (value: string): ResolvedGithubBaseUrl => {
	const raw = value.trim() || DEFAULT_GITHUB_URL;
	const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

	let parsed: URL;
	try {
		parsed = new URL(withScheme);
	} catch {
		// Keep the raw value rather than defaulting: the failure stays visible.
		return { baseUrl: withScheme, error: `"${raw}" is not a valid URL` };
	}

	if (parsed.protocol !== "https:") {
		return {
			baseUrl: parsed.origin,
			error:
				"Only https is supported. Creating the app over http would leave it orphaned on your instance.",
		};
	}

	// "acme.ghe.com." resolves the same as "acme.ghe.com", but the trailing dot
	// would slip past the checks below.
	if (parsed.hostname.endsWith(".")) {
		parsed.hostname = parsed.hostname.replace(/\.+$/, "");
	}

	const { hostname } = parsed;

	if (!hostname.includes(".")) {
		return {
			baseUrl: parsed.origin,
			error: `"${hostname}" is not a fully qualified hostname`,
		};
	}

	return { baseUrl: parsed.origin };
};
