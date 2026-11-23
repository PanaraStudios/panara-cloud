import { linkErrorRedirect as linkErrorTarget } from "@/lib/link-errors";
import {
	buildRouteTree,
	filesOf,
	matchRoute,
	type RouteMatch,
	type RouteParams,
} from "@/lib/route-match";
import type { RouteModule } from "./types";

// The layouts and boundaries around every page, down to the one that
// starts the session check and the Convex connection, come with the app's
// first script, so those start while the page's own code loads. Every other page, layout and boundary under app/
// is its own chunk, loaded on first use, as each route was with Next.js.
const shell = import.meta.glob<RouteModule>(
	[
		"/app/layout.tsx",
		"/app/error.tsx",
		"/app/not-found.tsx",
		"/app/(app)/layout.tsx",
		"/app/(app)/(auth)/layout.tsx",
	],
	{ eager: true },
);
const loaders = import.meta.glob<RouteModule>([
	"/app/**/{page,layout,error,not-found}.tsx",
	"!/app/layout.tsx",
	"!/app/error.tsx",
	"!/app/not-found.tsx",
	"!/app/(app)/layout.tsx",
	"!/app/(app)/(auth)/layout.tsx",
]);
const tree = buildRouteTree([...Object.keys(shell), ...Object.keys(loaders)]);
const modules = new Map<string, RouteModule>(Object.entries(shell));
const loading = new Map<string, Promise<RouteModule>>();

export type NavigationKind = "initial" | "push" | "replace" | "pop";

export type RouterState = {
	pathname: string;
	search: string;
	hash: string;
	match: RouteMatch | null;
	params: RouteParams;
	kind: NavigationKind;
	scroll: boolean;
	/** Changes on every committed navigation. */
	id: number;
};

const loadFile = (file: string): Promise<RouteModule> => {
	const done = modules.get(file);
	if (done) return Promise.resolve(done);
	let pending = loading.get(file);
	if (!pending) {
		pending = loaders[file]().then((mod) => {
			modules.set(file, mod);
			return mod;
		});
		pending.catch(() => loading.delete(file));
		loading.set(file, pending);
	}
	return pending;
};

export const routeModule = (file: string | undefined) =>
	file ? modules.get(file) : undefined;

export const rootFiles = () => tree.files;

const resolve = (pathname: string) => {
	const match = matchRoute(tree, pathname);
	const files = filesOf(match, tree);
	return {
		match,
		ready: files.every((file) => modules.has(file)),
		load: () => Promise.all(files.map(loadFile)),
	};
};

const sameParams = (a: RouteParams, b: RouteParams) => {
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every((key) => String(a[key]) === String(b[key]));
};

let state: RouterState = {
	pathname: "/",
	search: "",
	hash: "",
	match: null,
	params: {},
	kind: "initial",
	scroll: false,
	id: 0,
};
const listeners = new Set<() => void>();

export const getState = () => state;
export const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

type ProgressHooks = { start: () => void; stop: () => void };
let progress: ProgressHooks | null = null;
export const setProgressHooks = (hooks: ProgressHooks | null) => {
	progress = hooks;
};

const commit = (
	url: URL,
	match: RouteMatch | null,
	kind: NavigationKind,
	scroll: boolean,
) => {
	const params = match?.params ?? {};
	state = {
		pathname: url.pathname,
		search: url.search,
		hash: url.hash,
		match,
		params: sameParams(params, state.params) ? state.params : params,
		kind,
		scroll,
		id: state.id + 1,
	};
	for (const listener of listeners) listener();
};

type HistoryEntry = { panaraCloud: true; scrollY?: number };

const rememberScroll = () => {
	const entry: HistoryEntry = {
		...(window.history.state as HistoryEntry | null),
		panaraCloud: true,
		scrollY: window.scrollY,
	};
	window.history.replaceState(entry, "");
};

export const savedScroll = (): number | undefined =>
	(window.history.state as HistoryEntry | null)?.scrollY;

let latest = 0;

export type NavigateOptions = { replace?: boolean; scroll?: boolean };

export async function navigate(
	href: string,
	{ replace = false, scroll = true }: NavigateOptions = {},
) {
	const url = new URL(href, window.location.href);
	if (url.origin !== window.location.origin) {
		if (replace) window.location.replace(url.href);
		else window.location.assign(url.href);
		return;
	}
	const redirected = linkErrorRedirect(url);
	if (redirected) return navigate(redirected, { replace, scroll });
	const id = ++latest;
	const { match, ready, load } = resolve(url.pathname);
	if (!ready) {
		progress?.start();
		try {
			await load();
		} catch {
			// A chunk this build no longer has (the panel was updated while the
			// page was open): load the new version instead.
			window.location.assign(url.href);
			return;
		} finally {
			if (id === latest) progress?.stop();
		}
	}
	if (id !== latest) return;
	if (replace) {
		window.history.replaceState(
			{ ...(window.history.state as object | null), panaraCloud: true },
			"",
			url.href,
		);
	} else {
		rememberScroll();
		window.history.pushState({ panaraCloud: true }, "", url.href);
	}
	commit(url, match, replace ? "replace" : "push", scroll);
}

export function prefetch(href: string) {
	const url = new URL(href, window.location.href);
	if (url.origin !== window.location.origin) return;
	const { ready, load } = resolve(url.pathname);
	if (!ready) load().catch(() => {});
}

async function onPopState() {
	const url = new URL(window.location.href);
	const id = ++latest;
	const { match, ready, load } = resolve(url.pathname);
	if (!ready) {
		try {
			await load();
		} catch {
			window.location.reload();
			return;
		}
	}
	if (id !== latest) return;
	commit(url, match, "pop", true);
}

const linkErrorRedirect = (url: URL) =>
	linkErrorTarget(url.pathname, url.searchParams);

/**
 * Reads the first URL. The app renders at once with the code it has (the
 * shell, which starts the session check and the Convex connection); the
 * page's own code fills in as it arrives. Later navigations wait for the
 * next page's code instead, keeping the current page until then.
 */
export function startRouter() {
	window.history.scrollRestoration = "manual";
	let url = new URL(window.location.href);
	const redirected = linkErrorRedirect(url);
	if (redirected) {
		url = new URL(redirected, url);
		window.history.replaceState(null, "", url.href);
	}
	window.addEventListener("popstate", () => {
		void onPopState();
	});
	window.addEventListener("pagehide", rememberScroll);
	const { match, ready, load } = resolve(url.pathname);
	commit(url, match, "initial", true);
	if (ready) return;
	load().then(
		() => {
			try {
				sessionStorage.removeItem("panara-cloud:reloaded");
			} catch {}
			state = { ...state };
			for (const listener of listeners) listener();
		},
		(error: unknown) => {
			// The page's code did not load (a network error, or a build
			// replaced since index.html was fetched): one fresh load, then the
			// error.
			const key = "panara-cloud:reloaded";
			try {
				if (!sessionStorage.getItem(key)) {
					sessionStorage.setItem(key, "1");
					window.location.reload();
					return;
				}
			} catch {}
			throw error;
		},
	);
}
