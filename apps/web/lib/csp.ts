// The browser talks to this origin, Convex (HTTP + WebSocket) and the agent's
// live endpoint (terminals, logs). Their URLs differ per install, so the
// policy is built at request time from the server's env.

const origins = (value: string | undefined) => {
	if (!value) return [];
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return [];
	}
	const secure = url.protocol === "https:" || url.protocol === "wss:";
	const host = url.host;
	return secure
		? [`https://${host}`, `wss://${host}`]
		: [`http://${host}`, `ws://${host}`];
};

export function contentSecurityPolicy({
	convexUrl,
	liveUrl,
	dev = false,
}: {
	convexUrl?: string;
	liveUrl?: string;
	dev?: boolean;
}) {
	const connect = new Set([
		"'self'",
		...origins(convexUrl),
		...origins(liveUrl),
	]);
	// Without PANARA_CLOUD_LIVE_URL (older web service env) the live endpoint
	// is unknown; allow WebSockets rather than break terminals and logs.
	if (!liveUrl || dev) {
		connect.add("ws:");
		connect.add("wss:");
	}
	const directives: Record<string, string[]> = {
		"default-src": ["'self'"],
		// Next's inline bootstrap scripts; React's dev build also needs eval.
		"script-src": [
			"'self'",
			"'unsafe-inline'",
			...(dev ? ["'unsafe-eval'"] : []),
		],
		"style-src": ["'self'", "'unsafe-inline'"],
		"img-src": ["'self'", "data:", "blob:", "https:"],
		"font-src": ["'self'", "data:"],
		"connect-src": [...connect],
		"worker-src": ["'self'", "blob:"],
		"object-src": ["'none'"],
		"base-uri": ["'self'"],
		"form-action": ["'self'"],
		"frame-ancestors": ["'none'"],
	};
	return Object.entries(directives)
		.map(([name, values]) => `${name} ${values.join(" ")}`)
		.join("; ");
}

export const HSTS = "max-age=31536000; includeSubDomains";
