import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { buildRouteTree, filesOf, matchRoute } from "./route-match.ts";

const appDir = join(import.meta.dirname, "..", "app");
const listFiles = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? listFiles(join(dir, entry.name))
			: [`/app/${relative(appDir, join(dir, entry.name))}`],
	);
const tree = buildRouteTree(listFiles(appDir));

const pageOf = (path: string) => {
	const match = matchRoute(tree, path);
	return match?.nodes.at(-1)?.files.page?.replace(/^\/app\//, "");
};

test("static segments win over dynamic ones and catch-alls", () => {
	assert.equal(pageOf("/"), "(app)/(dashboard)/page.tsx");
	assert.equal(pageOf("/login"), "(app)/(auth)/login/page.tsx");
	assert.equal(
		pageOf("/servers/new"),
		"(app)/(dashboard)/servers/new/page.tsx",
	);
	assert.equal(
		pageOf("/servers/abc"),
		"(app)/(dashboard)/servers/[serverId]/page.tsx",
	);
	assert.equal(
		pageOf("/settings/dns/p1/edit"),
		"(app)/(dashboard)/settings/dns/[dnsProviderId]/edit/page.tsx",
	);
	assert.equal(
		pageOf("/settings/dns/p1/z1"),
		"(app)/(dashboard)/settings/dns/[dnsProviderId]/[zoneId]/page.tsx",
	);
});

test("anything else lands on the dashboard's catch-all", () => {
	assert.equal(
		pageOf("/zz-no-such-page"),
		"(app)/(dashboard)/[...pending]/page.tsx",
	);
	assert.equal(
		pageOf("/servers/abc/nope/deeper"),
		"(app)/(dashboard)/[...pending]/page.tsx",
	);
	assert.deepEqual(matchRoute(tree, "/a/b")?.params, { pending: ["a", "b"] });
});

test("params and keys of a service page", () => {
	const match = matchRoute(
		tree,
		"/projects/p1/environment/e1/services/application/s1/settings/domains/d1",
	);
	assert.ok(match);
	assert.deepEqual(match.params, {
		projectId: "p1",
		environmentId: "e1",
		kind: "application",
		id: "s1",
		domainId: "d1",
	});
	assert.deepEqual(match.keys, [
		"",
		"(app)",
		"(dashboard)",
		"projects",
		"p1",
		"environment",
		"e1",
		"services",
		"application",
		"s1",
		"settings",
		"domains",
		"d1",
	]);
	const files = filesOf(match, tree);
	assert.ok(files.includes("/app/layout.tsx"));
	// The page of an ancestor route is not part of this one.
	assert.ok(!files.includes("/app/(app)/(dashboard)/page.tsx"));
	assert.ok(
		files.includes(
			"/app/(app)/(dashboard)/projects/[projectId]/environment/[environmentId]/services/[kind]/[id]/settings/domains/[domainId]/page.tsx",
		),
	);
	assert.ok(files.includes("/app/not-found.tsx"));
	assert.ok(files.includes("/app/(app)/(dashboard)/error.tsx"));
	assert.ok(
		files.includes(
			"/app/(app)/(dashboard)/projects/[projectId]/environment/[environmentId]/services/[kind]/[id]/layout.tsx",
		),
	);
});

test("params stay as they appear in the URL", () => {
	assert.deepEqual(matchRoute(tree, "/servers/s1/images/sha256%3Aab")?.params, {
		serverId: "s1",
		imageId: "sha256%3Aab",
	});
});

test("optional catch-alls match nothing as well", () => {
	const small = buildRouteTree(["/app/docs/[[...slug]]/page.tsx"]);
	assert.deepEqual(matchRoute(small, "/docs")?.params, { slug: [] });
	assert.deepEqual(matchRoute(small, "/docs/a/b")?.params, {
		slug: ["a", "b"],
	});
	assert.equal(matchRoute(small, "/other"), null);
});
