import {
	Component,
	type ComponentType,
	Fragment,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import type { RouteMatch, RouteParams } from "@/lib/route-match";
import {
	getState,
	getView,
	navigate,
	prefetch,
	type RouterState,
	rootFiles,
	routeModule,
	savedScroll,
	subscribe,
} from "./store";
import type { ErrorBoundaryProps, Metadata, RouteModule } from "./types";

// The app's router: Next.js App Router behaviour (nested layouts, error and
// not-found boundaries, metadata titles, the navigation hooks) for a client
// build served as static files. Pages live in app/ as before.

export { startRouter } from "./store";
export type { Metadata };

const SITE_TITLE = "Panara Cloud";

export function usePathname(): string {
	return useSyncExternalStore(subscribe, () => getState().pathname);
}

export function useSearchParams(): URLSearchParams {
	const search = useSyncExternalStore(subscribe, () => getState().search);
	return useMemo(() => new URLSearchParams(search), [search]);
}

export function useParams<
	T extends Record<string, string | string[]> = RouteParams,
>(): T {
	return useSyncExternalStore(subscribe, () => getState().params) as T;
}

export type AppRouter = {
	push: (href: string, options?: { scroll?: boolean }) => void;
	replace: (href: string, options?: { scroll?: boolean }) => void;
	back: () => void;
	forward: () => void;
	/** Data comes from live Convex queries, so there is nothing to refetch. */
	refresh: () => void;
	prefetch: (href: string) => void;
};

const router: AppRouter = {
	push: (href, options) => {
		void navigate(href, { scroll: options?.scroll });
	},
	replace: (href, options) => {
		void navigate(href, { replace: true, scroll: options?.scroll });
	},
	back: () => window.history.back(),
	forward: () => window.history.forward(),
	refresh: () => {},
	prefetch,
};

export function useRouter(): AppRouter {
	return router;
}

class RedirectSignal extends Error {
	constructor(readonly url: string) {
		super(`Redirect to ${url}`);
	}
}

class NotFoundSignal extends Error {
	constructor() {
		super("Not found");
	}
}

export function redirect(url: string): never {
	throw new RedirectSignal(url);
}

export function notFound(): never {
	throw new NotFoundSignal();
}

export const isRouterSignal = (error: unknown) =>
	error instanceof RedirectSignal || error instanceof NotFoundSignal;

type BoundaryProps = { resetKey: string | number; children: ReactNode };

// Resets when the route changes, like Next.js's boundaries do.
class RedirectBoundary extends Component<
	BoundaryProps,
	{ url: string | null; resetKey: string | number }
> {
	state = { url: null as string | null, resetKey: this.props.resetKey };
	static getDerivedStateFromError(error: unknown) {
		if (error instanceof RedirectSignal) return { url: error.url };
		throw error;
	}
	static getDerivedStateFromProps(
		props: BoundaryProps,
		state: { url: string | null; resetKey: string | number },
	) {
		return props.resetKey === state.resetKey
			? null
			: { url: null, resetKey: props.resetKey };
	}
	componentDidCatch(error: unknown) {
		if (error instanceof RedirectSignal) {
			void navigate(error.url, { replace: true });
		}
	}
	render() {
		return this.state.url === null ? this.props.children : null;
	}
}

type FallbackProps = BoundaryProps & {
	fallback: ComponentType<ErrorBoundaryProps>;
};

class ErrorBoundary extends Component<
	FallbackProps,
	{ error: Error | null; resetKey: string | number }
> {
	state = { error: null as Error | null, resetKey: this.props.resetKey };
	static getDerivedStateFromError(error: unknown) {
		if (isRouterSignal(error)) throw error;
		return { error: error instanceof Error ? error : new Error(String(error)) };
	}
	static getDerivedStateFromProps(
		props: FallbackProps,
		state: { error: Error | null; resetKey: string | number },
	) {
		return props.resetKey === state.resetKey
			? null
			: { error: null, resetKey: props.resetKey };
	}
	reset = () => this.setState({ error: null });
	render() {
		const Fallback = this.props.fallback;
		return this.state.error ? (
			<Fallback error={this.state.error} reset={this.reset} />
		) : (
			this.props.children
		);
	}
}

type NotFoundProps = BoundaryProps & { fallback: ComponentType };

class NotFoundBoundary extends Component<
	NotFoundProps,
	{ notFound: boolean; resetKey: string | number }
> {
	state = { notFound: false, resetKey: this.props.resetKey };
	static getDerivedStateFromError(error: unknown) {
		if (error instanceof NotFoundSignal) return { notFound: true };
		throw error;
	}
	static getDerivedStateFromProps(
		props: NotFoundProps,
		state: { notFound: boolean; resetKey: string | number },
	) {
		return props.resetKey === state.resetKey
			? null
			: { notFound: false, resetKey: props.resetKey };
	}
	render() {
		const Fallback = this.props.fallback;
		return this.state.notFound ? <Fallback /> : this.props.children;
	}
}

// Next.js's title rules: a string title fills the nearest template above it,
// `absolute` ignores templates, `default` applies until a deeper segment
// sets a title, and a `template` applies to segments below its own.
export function resolveTitle(chain: (Metadata | undefined)[]): string {
	let template: string | null = null;
	let title = SITE_TITLE;
	for (const metadata of chain) {
		const value = metadata?.title;
		if (value === undefined) continue;
		if (typeof value === "string") {
			title = template ? template.replace("%s", value) : value;
		} else {
			if (value.absolute !== undefined) title = value.absolute;
			else if (value.default !== undefined) title = value.default;
			if (value.template !== undefined) template = value.template;
		}
	}
	return title;
}

const moduleChain = (match: RouteMatch): (RouteModule | undefined)[] =>
	match.nodes.flatMap((node, i) => [
		routeModule(node.files.layout),
		...(i === match.nodes.length - 1 ? [routeModule(node.files.page)] : []),
	]);

function useTitle(title: string, id: number) {
	// A layout effect, so a page's own effect (a service page names the
	// service) still runs after it and wins. The title also changes when the
	// first page's code arrives after the shell has rendered.
	useLayoutEffect(() => {
		document.title = title;
	}, [id, title]);
}

function NotFoundTitle({ children }: { children: ReactNode }) {
	const root = routeModule(rootFiles().layout);
	const own = routeModule(rootFiles()["not-found"]);
	const title = resolveTitle([root?.metadata, own?.metadata]);
	useLayoutEffect(() => {
		document.title = title;
	}, [title]);
	return children;
}

function NotFoundPage() {
	const NotFound = routeModule(rootFiles()["not-found"])?.default;
	return <NotFoundTitle>{NotFound ? <NotFound /> : null}</NotFoundTitle>;
}

function routeTree(state: RouterState): ReactNode {
	const { match } = state;
	const resetKey = state.pathname;
	if (!match) {
		const Root = routeModule(rootFiles().layout)?.default ?? Fragment;
		return (
			<Root>
				<NotFoundPage />
			</Root>
		);
	}
	let element: ReactNode = null;
	for (let i = match.nodes.length - 1; i >= 0; i--) {
		const node = match.nodes[i];
		if (i === match.nodes.length - 1) {
			const Page = routeModule(node.files.page)?.default ?? Fragment;
			element = <Page key="__PAGE__" />;
		}
		element = (
			<RedirectBoundary resetKey={state.id}>{element}</RedirectBoundary>
		);
		if (node.files["not-found"]) {
			element = (
				<NotFoundBoundary resetKey={resetKey} fallback={NotFoundPage}>
					{element}
				</NotFoundBoundary>
			);
		}
		const error = routeModule(node.files.error)?.default;
		if (error) {
			element = (
				<ErrorBoundary
					resetKey={resetKey}
					fallback={error as ComponentType<ErrorBoundaryProps>}
				>
					{element}
				</ErrorBoundary>
			);
		}
		const Layout = routeModule(node.files.layout)?.default;
		if (Layout) element = <Layout>{element}</Layout>;
		element = <Fragment key={match.keys[i]}>{element}</Fragment>;
	}
	return element;
}

function useScrollOnNavigation(state: RouterState) {
	const previous = useRef<RouterState | null>(null);
	useLayoutEffect(() => {
		const before = previous.current;
		previous.current = state;
		// `behavior: "instant"`: the page sets scroll-behavior: smooth, which
		// should not animate a jump to a new page.
		const to = (top: number) =>
			window.scrollTo({ top, left: 0, behavior: "instant" });
		if (state.kind === "pop" || state.kind === "initial") {
			const y = savedScroll();
			if (y !== undefined || state.kind === "pop") to(y ?? 0);
			return;
		}
		if (!state.scroll) return;
		if (state.hash) {
			const target = document.getElementById(
				decodeURIComponent(state.hash.slice(1)),
			);
			if (target) {
				target.scrollIntoView();
				return;
			}
		}
		if (
			!before ||
			before.pathname !== state.pathname ||
			before.search !== state.search
		) {
			to(0);
		}
	}, [state.id]);
}

// Tells screen readers which page a client-side navigation opened, as
// Next.js's route announcer did: the title, else the heading, else the path.
function RouteAnnouncer({ id, kind }: { id: number; kind: string }) {
	const [message, setMessage] = useState("");
	useEffect(() => {
		if (kind === "initial") return;
		const heading = document.querySelector("h1")?.textContent;
		setMessage(document.title || heading || window.location.pathname);
	}, [id, kind]);
	return (
		<div aria-live="assertive" className="sr-only" data-route-announcer="">
			{message}
		</div>
	);
}

export function RouterView() {
	const state = useSyncExternalStore(subscribe, getView);
	useScrollOnNavigation(state);
	const title = state.match
		? resolveTitle(moduleChain(state.match).map((mod) => mod?.metadata))
		: SITE_TITLE;
	useTitle(title, state.id);
	return (
		<>
			{routeTree(state)}
			<RouteAnnouncer id={state.id} kind={state.kind} />
		</>
	);
}
