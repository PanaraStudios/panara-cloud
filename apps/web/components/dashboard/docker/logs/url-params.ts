export function readParam(name: string): string {
	if (typeof window === "undefined") return "";
	return new URLSearchParams(window.location.search).get(name) ?? "";
}

/** Replaces the given query params in place (null removes one). */
export function writeParams(values: Record<string, string | null>) {
	const url = new URL(window.location.href);
	for (const [key, value] of Object.entries(values)) {
		if (value === null) url.searchParams.delete(key);
		else url.searchParams.set(key, value);
	}
	if (url.href !== window.location.href) {
		window.history.replaceState(window.history.state, "", url);
	}
}
