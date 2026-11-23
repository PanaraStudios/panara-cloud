// The app/ directory read as a route tree, with Next.js's App Router rules:
// `(group)` folders add a layout without a URL segment, `[name]` matches one
// segment, `[...name]` one or more, `[[...name]]` zero or more, and a static
// segment beats a dynamic one, which beats a catch-all.

export type RouteFile = "layout" | "page" | "error" | "not-found";

type SegmentKind =
	| "group"
	| "static"
	| "dynamic"
	| "catchAll"
	| "optionalCatchAll";

export type RouteNode = {
	segment: string;
	kind: SegmentKind;
	param?: string;
	files: Partial<Record<RouteFile, string>>;
	children: RouteNode[];
};

export type RouteParams = Record<string, string | string[]>;

export type RouteMatch = {
	/** From the root to the node whose page renders. */
	nodes: RouteNode[];
	/** One per node: the URL text it matched, which keys its subtree. */
	keys: string[];
	params: RouteParams;
};

const FILE = /^(.*)\/(layout|page|error|not-found)\.tsx$/;

const kindOf = (segment: string): Pick<RouteNode, "kind" | "param"> => {
	if (/^\(.+\)$/.test(segment)) return { kind: "group" };
	let m = /^\[\[\.\.\.(.+)\]\]$/.exec(segment);
	if (m) return { kind: "optionalCatchAll", param: m[1] };
	m = /^\[\.\.\.(.+)\]$/.exec(segment);
	if (m) return { kind: "catchAll", param: m[1] };
	m = /^\[(.+)\]$/.exec(segment);
	if (m) return { kind: "dynamic", param: m[1] };
	return { kind: "static" };
};

/** `paths` are module paths such as `/app/(app)/login/page.tsx`. */
export function buildRouteTree(paths: string[]): RouteNode {
	const root: RouteNode = {
		segment: "",
		kind: "static",
		files: {},
		children: [],
	};
	for (const path of paths) {
		const m = FILE.exec(path.replace(/^\.?\/?app/, ""));
		if (!m) continue;
		let node = root;
		for (const segment of m[1].split("/").filter(Boolean)) {
			let child = node.children.find((c) => c.segment === segment);
			if (!child) {
				child = { segment, ...kindOf(segment), files: {}, children: [] };
				node.children.push(child);
			}
			node = child;
		}
		node.files[m[2] as RouteFile] = path;
	}
	return root;
}

type Candidate = RouteMatch & { score: number[] };

const RANK: Record<SegmentKind, number> = {
	group: -1,
	static: 3,
	dynamic: 2,
	catchAll: 1,
	optionalCatchAll: 0,
};

function walk(
	node: RouteNode,
	segments: string[],
	at: number,
	found: Candidate,
	out: Candidate[],
) {
	if (at === segments.length && node.files.page) out.push(found);
	for (const child of node.children) {
		const extend = (key: string, consumed: number, value?: string[]) => {
			const params = { ...found.params };
			if (child.param && value) {
				params[child.param] = child.kind === "dynamic" ? value[0] : [...value];
			}
			const next: Candidate = {
				nodes: [...found.nodes, child],
				keys: [...found.keys, key],
				params,
				score:
					child.kind === "group"
						? found.score
						: [...found.score, RANK[child.kind]],
			};
			walk(child, segments, at + consumed, next, out);
		};
		const rest = segments.slice(at);
		switch (child.kind) {
			case "group":
				extend(child.segment, 0);
				break;
			case "static":
				if (segments[at] === child.segment) extend(child.segment, 1);
				break;
			case "dynamic":
				if (at < segments.length) extend(segments[at], 1, [segments[at]]);
				break;
			case "catchAll":
				if (rest.length > 0) extend(rest.join("/"), rest.length, rest);
				break;
			case "optionalCatchAll":
				extend(rest.join("/"), rest.length, rest);
				break;
		}
	}
}

const better = (a: number[], b: number[]) => {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const x = a[i] ?? -2;
		const y = b[i] ?? -2;
		if (x !== y) return x > y;
	}
	return false;
};

export function matchRoute(
	root: RouteNode,
	pathname: string,
): RouteMatch | null {
	const segments = pathname.split("/").filter(Boolean);
	const out: Candidate[] = [];
	walk(
		root,
		segments,
		0,
		{ nodes: [root], keys: [""], params: {}, score: [] },
		out,
	);
	let best: Candidate | null = null;
	for (const candidate of out) {
		if (!best || better(candidate.score, best.score)) best = candidate;
	}
	if (!best) return null;
	const { score: _, ...match } = best;
	return match;
}

/** Module paths a match needs before it can render. */
export function filesOf(match: RouteMatch | null, root: RouteNode): string[] {
	const files = new Set<string>();
	for (const file of Object.values(root.files)) files.add(file);
	const nodes = match?.nodes ?? [];
	nodes.forEach((node, i) => {
		for (const [kind, file] of Object.entries(node.files)) {
			if (kind !== "page" || i === nodes.length - 1) files.add(file);
		}
	});
	return [...files];
}
