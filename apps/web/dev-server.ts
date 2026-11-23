import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
// Relative paths, so the config bundler compiles them instead of leaving
// the workspace package to Node.
import catalogJson from "../../packages/backend/api/catalog.json";
import {
	type Catalog,
	openApiDocument,
} from "../../packages/backend/convex/platform/lib/apiSpec";

// What the production web server (apps/web/server) adds around the static
// files, for `vite` in development and `vite build`:
// - the OpenAPI document, written into the build as /api/v1/openapi.json;
// - in development, the runtime config in index.html, /api/health, and the
//   /api/* proxies to the Convex site URL with the same headers the
//   production server sends.

export const OPENAPI_PATH = "api/v1/openapi.json";
const CONFIG_PLACEHOLDER =
	'<script type="application/json" id="panara-cloud-config">{}</script>';

const openApiJson = () =>
	JSON.stringify(openApiDocument(catalogJson as Catalog));

const CLIENT_IP_HEADER = "x-panara-cloud-client-ip";
const PROXY_SECRET_HEADER = "x-panara-cloud-proxy-secret";
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"transfer-encoding",
	"content-length",
	"upgrade",
	"te",
	"trailer",
	"proxy-connection",
]);

const first = (value: string | string[] | undefined) =>
	(Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim() || null;

const forwardedFor = (req: IncomingMessage) =>
	typeof req.headers["x-forwarded-for"] === "string"
		? req.headers["x-forwarded-for"]
		: (req.socket.remoteAddress ?? "");

const clientIpProof = (req: IncomingMessage): Record<string, string> => {
	const secret = process.env.PANARA_CLOUD_PROXY_SECRET;
	const ip =
		forwardedFor(req).split(",").at(-1)?.trim() ||
		first(req.headers["x-real-ip"]) ||
		"";
	return secret && ip
		? { [PROXY_SECRET_HEADER]: secret, [CLIENT_IP_HEADER]: ip }
		: {};
};

const readBody = (req: IncomingMessage) =>
	new Promise<Buffer>((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});

const send = async (res: ServerResponse, upstream: Response) => {
	res.statusCode = upstream.status;
	for (const [name, value] of upstream.headers) {
		if (name === "set-cookie" || HOP_BY_HOP.has(name)) continue;
		if (name === "content-encoding") continue;
		res.setHeader(name, value);
	}
	const cookies = upstream.headers.getSetCookie();
	if (cookies.length) res.setHeader("set-cookie", cookies);
	res.end(Buffer.from(await upstream.arrayBuffer()));
};

const proxy = async (
	req: IncomingMessage,
	res: ServerResponse,
	path: string,
	headers: Record<string, string>,
) => {
	const site = process.env.CONVEX_INTERNAL_SITE_URL?.replace(/\/+$/, "");
	if (!site) {
		res.statusCode = 503;
		res.end("CONVEX_INTERNAL_SITE_URL is not set");
		return;
	}
	const body =
		req.method === "GET" || req.method === "HEAD"
			? undefined
			: await readBody(req);
	const upstream = await fetch(`${site}${path}`, {
		method: req.method,
		headers,
		body: body?.length ? new Uint8Array(body) : undefined,
		redirect: "manual",
	});
	await send(res, upstream);
};

const passHeaders = (req: IncomingMessage, names?: string[]) => {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(req.headers)) {
		if (typeof value !== "string" || HOP_BY_HOP.has(name)) continue;
		if (name === "host" || name === CLIENT_IP_HEADER) continue;
		if (name === PROXY_SECRET_HEADER) continue;
		if (names && !names.includes(name)) continue;
		out[name] = value;
	}
	return { ...out, ...clientIpProof(req) };
};

async function handleApi(req: IncomingMessage, res: ServerResponse) {
	const url = new URL(req.url ?? "/", "http://localhost");
	const path = `${url.pathname}${url.search}`;
	if (url.pathname === "/api/health") {
		res.setHeader("content-type", "application/json");
		res.setHeader("cache-control", "no-store");
		res.end(JSON.stringify({ status: "ok" }));
	} else if (url.pathname === `/${OPENAPI_PATH}`) {
		res.setHeader("content-type", "application/json");
		res.setHeader("access-control-allow-origin", "*");
		res.end(openApiJson());
	} else if (url.pathname.startsWith("/api/auth/")) {
		const headers = passHeaders(req);
		delete headers["x-forwarded-host"];
		delete headers["x-forwarded-proto"];
		headers["accept-encoding"] = "application/json";
		headers["x-better-auth-forwarded-host"] = req.headers.host ?? "";
		headers["x-better-auth-forwarded-proto"] = "http";
		await proxy(req, res, path, headers);
	} else if (url.pathname.startsWith("/api/v1/")) {
		await proxy(
			req,
			res,
			path,
			passHeaders(req, [
				"accept",
				"authorization",
				"content-type",
				"x-api-key",
			]),
		);
	} else if (url.pathname === "/api/mcp") {
		await proxy(req, res, path, passHeaders(req));
	} else if (url.pathname.startsWith("/api/connect/")) {
		const token = url.pathname.slice("/api/connect/".length);
		const host = first(req.headers["x-forwarded-host"]) ?? req.headers.host;
		const proto = first(req.headers["x-forwarded-proto"]) ?? "http";
		await proxy(req, res, `/infra/connect/${token}${url.search}`, {
			"x-panara-cloud-connect-url": `${proto}://${host}/api/connect/${token}`,
			[CLIENT_IP_HEADER]: forwardedFor(req).split(",")[0]?.trim() ?? "",
		});
	} else {
		res.statusCode = 404;
		res.end();
	}
}

// The Latin faces the first screen draws with, preloaded as next/font did,
// so text does not wait for the stylesheet to ask for them.
const PRELOADED_FONTS = [
	/^assets\/bricolage-grotesque-latin-opsz-normal-[^/]+\.woff2$/,
	/^assets\/geist-mono-latin-400-normal-[^/]+\.woff2$/,
	/^assets\/instrument-serif-latin-400-italic-[^/]+\.woff2$/,
];

export function fontPreloads(): Plugin {
	return {
		name: "panara-cloud-font-preloads",
		apply: "build",
		transformIndexHtml: {
			order: "post",
			handler(_html, { bundle }) {
				const files = Object.keys(bundle ?? {}).filter((file) =>
					PRELOADED_FONTS.some((pattern) => pattern.test(file)),
				);
				if (files.length !== PRELOADED_FONTS.length) {
					throw new Error(
						`Expected ${PRELOADED_FONTS.length} fonts to preload, found ${files.length}`,
					);
				}
				return files.map((file) => ({
					tag: "link",
					attrs: {
						rel: "preload",
						href: `/${file}`,
						as: "font",
						type: "font/woff2",
						crossorigin: "",
					},
					injectTo: "head" as const,
				}));
			},
		},
	};
}

export const ROUTES_FILE = "routes.json";

type RouteTable = {
	/** Every route module under app/, as `/app/...` paths. */
	files: string[];
	/**
	 * For each of those that loads lazily: the build files it needs; under
	 * "*", what the app's first script imports, needed on every page.
	 */
	preload: Record<string, string[]>;
};

// The web server answers a page route with index.html plus preload links for
// that route's code, read from this table, so the browser fetches it all at
// once as it did with Next.js instead of finding it chunk by chunk.
export function routePreloads(): Plugin {
	let root = "";
	return {
		name: "panara-cloud-route-preloads",
		apply: "build",
		configResolved(config) {
			root = config.root;
		},
		generateBundle(_options, bundle) {
			const chunks = Object.values(bundle).filter(
				(file) => file.type === "chunk",
			);
			const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
			const closure = (fileName: string, into: Set<string>) => {
				if (into.has(fileName)) return;
				into.add(fileName);
				const chunk = byFile.get(fileName);
				if (!chunk) return;
				for (const css of chunk.viteMetadata?.importedCss ?? []) into.add(css);
				for (const imported of chunk.imports) closure(imported, into);
			};
			const loaded = new Set<string>();
			for (const chunk of chunks.filter((c) => c.isEntry)) {
				closure(chunk.fileName, loaded);
			}
			const entries = chunks.filter((c) => c.isEntry).map((c) => c.fileName);
			const table: RouteTable = {
				files: [],
				preload: {
					"*": [...loaded].filter(
						(f) => !entries.includes(f) && !f.endsWith(".css"),
					),
				},
			};
			const ROUTE = /\/app\/.*\/?(page|layout|error|not-found)\.tsx$/;
			for (const chunk of chunks) {
				for (const id of chunk.moduleIds) {
					const path = id.startsWith(root) ? id.slice(root.length) : id;
					if (!ROUTE.test(path) || !path.startsWith("/app/")) continue;
					table.files.push(path);
					// Small route chunks are merged, so the chunk a route module
					// sits in is what its import loads.
					if (!loaded.has(chunk.fileName)) {
						const needed = new Set<string>();
						closure(chunk.fileName, needed);
						table.preload[path] = [...needed].filter((f) => !loaded.has(f));
					}
				}
			}
			table.files.sort();
			this.emitFile({
				type: "asset",
				fileName: ROUTES_FILE,
				source: JSON.stringify(table),
			});
		},
	};
}

export function devServer(): Plugin {
	return {
		name: "panara-cloud-web-server",
		transformIndexHtml: {
			order: "pre",
			handler(html, { server }) {
				if (!server) return html;
				const config = JSON.stringify({
					convexUrl: process.env.CONVEX_PUBLIC_URL,
				}).replaceAll("<", "\\u003c");
				return html.replace(
					CONFIG_PLACEHOLDER,
					CONFIG_PLACEHOLDER.replace("{}", config),
				);
			},
		},
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				if (!req.url?.startsWith("/api/")) {
					next();
					return;
				}
				handleApi(req, res).catch((error: unknown) => {
					server.config.logger.error(String(error));
					res.statusCode = 502;
					res.end();
				});
			});
		},
		generateBundle() {
			this.emitFile({
				type: "asset",
				fileName: OPENAPI_PATH,
				source: openApiJson(),
			});
		},
	};
}
