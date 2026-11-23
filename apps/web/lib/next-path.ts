const BASE = "http://panara-cloud.invalid";

// Only same-origin paths: `next` comes from the query string. Browsers drop
// tabs and newlines inside URLs ("/\t/evil.com" is "//evil.com"), so control
// characters are refused and the result is what the URL parser resolved.
export function safeNext(value: string | null | undefined, fallback = "/") {
	if (
		!value?.startsWith("/") ||
		value.startsWith("//") ||
		// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
		/[\u0000-\u001f\u007f\\]/.test(value)
	) {
		return fallback;
	}
	let url: URL;
	try {
		url = new URL(value, BASE);
	} catch {
		return fallback;
	}
	if (url.origin !== BASE) return fallback;
	const path = `${url.pathname}${url.search}${url.hash}`;
	return path.startsWith("//") ? fallback : path;
}

export function withNext(path: string, next: string) {
	if (next === "/") return path;
	const separator = path.includes("?") ? "&" : "?";
	return `${path}${separator}next=${encodeURIComponent(next)}`;
}
