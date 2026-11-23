// Per-install settings the web server writes into index.html as a JSON block
// (a data block, so the Content-Security-Policy needs no inline script).
type RuntimeConfig = { convexUrl: string };

let config: RuntimeConfig | undefined;

export function runtimeConfig(): RuntimeConfig {
	if (config) return config;
	const text = document.getElementById("panara-cloud-config")?.textContent;
	const parsed = text ? (JSON.parse(text) as Partial<RuntimeConfig>) : {};
	if (!parsed.convexUrl) {
		throw new Error(
			"The panel's configuration has no Convex URL (CONVEX_PUBLIC_URL on the web service).",
		);
	}
	config = { convexUrl: parsed.convexUrl };
	return config;
}
