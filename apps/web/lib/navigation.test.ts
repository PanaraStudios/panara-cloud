import assert from "node:assert/strict";
import { test } from "node:test";
import {
	activityNav,
	canReadRequests,
	hasSourceTab,
	movedSettingsSection,
	placeForEvent,
	type ServiceKind,
	type ServiceRef,
	serverNav,
	serviceNav,
	serviceUrl,
	settingsSectionEvents,
	settingsSectionForEvent,
	settingsSectionsFor,
	sourceTabEvents,
	visibleItems,
} from "./navigation.ts";

const ref = (kind: ServiceKind): ServiceRef => ({
	projectId: "p",
	environmentId: "e",
	kind,
	id: "s",
});
const tabs = (kind: ServiceKind) =>
	serviceNav(ref(kind)).map((item) => item.title);

test("an application and a compose service have Source right after Overview", () => {
	const expected = [
		"Overview",
		"Source",
		"Deployments",
		"Logs",
		"Metrics",
		"Settings",
	];
	assert.deepEqual(tabs("application"), expected);
	assert.deepEqual(tabs("compose"), expected);
	const source = serviceNav(ref("application")).find(
		(item) => item.title === "Source",
	);
	assert.equal(source?.url, `${serviceUrl(ref("application"))}/source`);
});

test("a database has no Source tab", () => {
	for (const kind of ["postgres", "redis", "libsql"] as const) {
		assert.equal(hasSourceTab(kind), false);
		assert.deepEqual(tabs(kind), [
			"Overview",
			"Backups",
			"Logs",
			"Metrics",
			"Settings",
		]);
		assert.deepEqual(sourceTabEvents(kind), []);
	}
});

test("Settings no longer lists the compose file", () => {
	for (const kind of ["application", "compose", "postgres"] as const) {
		const slugs = settingsSectionsFor(kind).map((section) => section.slug);
		assert.equal(slugs.includes("compose-file"), false);
		assert.equal(slugs.includes("source"), false);
		assert.equal(slugs[0], "general");
	}
	const children = serviceNav(ref("compose")).find(
		(item) => item.title === "Settings",
	)?.children;
	assert.equal(
		children?.some((item) => item.title === "Compose file"),
		false,
	);
});

test("old settings links lead to the Source tab", () => {
	assert.equal(movedSettingsSection("compose", "compose-file"), "source");
	assert.equal(movedSettingsSection("application", "source"), "source");
	assert.equal(movedSettingsSection("application", "build"), "source");
	assert.equal(movedSettingsSection("compose", "source"), "source");
	assert.equal(movedSettingsSection("application", "compose-file"), undefined);
	assert.equal(movedSettingsSection("compose", "build"), undefined);
	assert.equal(movedSettingsSection("postgres", "source"), undefined);
	assert.equal(movedSettingsSection("application", "general"), undefined);
	assert.equal(movedSettingsSection("application", "environment"), undefined);
});

test("a staged change points at the page it was made on", () => {
	assert.equal(
		placeForEvent("application", "config.source")?.section,
		"source",
	);
	assert.equal(placeForEvent("application", "config.build")?.section, "source");
	assert.equal(placeForEvent("compose", "config.source")?.section, "source");
	assert.equal(
		placeForEvent("compose", "config.composeFile")?.section,
		"source",
	);
	assert.equal(placeForEvent("application", "config.source")?.title, "Source");
	// A database's image is still set in its General settings.
	assert.equal(
		placeForEvent("postgres", "config.source")?.section,
		"settings/general",
	);
	assert.equal(
		placeForEvent("application", "config.env")?.section,
		"settings/environment",
	);
	assert.equal(
		placeForEvent("application", "config.server")?.section,
		"settings/general",
	);
	assert.equal(placeForEvent("application", "lifecycle.start"), undefined);
});

test("Settings sections carry no dot for a change made on the Source tab", () => {
	assert.equal(
		settingsSectionForEvent("application", "config.source"),
		undefined,
	);
	assert.equal(
		settingsSectionForEvent("application", "config.build"),
		undefined,
	);
	assert.equal(
		settingsSectionForEvent("compose", "config.composeFile"),
		undefined,
	);
	assert.equal(settingsSectionForEvent("postgres", "config.source"), "general");
	assert.equal(settingsSectionForEvent("application", "config.ports"), "ports");
});

test("General no longer reports a source or build change of an application", () => {
	const general = (kind: ServiceKind) => {
		const section = settingsSectionsFor(kind).find(
			(item) => item.slug === "general",
		);
		assert.ok(section);
		return settingsSectionEvents(kind, section);
	};
	assert.equal(general("application").includes("config.source"), false);
	assert.equal(general("application").includes("config.build"), false);
	assert.equal(general("application").includes("config.server"), true);
	assert.equal(general("compose").includes("config.source"), false);
	assert.equal(general("postgres").includes("config.source"), true);
});

test("a server's cluster tab is called Cluster and lives at /cluster", () => {
	const cluster = serverNav("srv1").find((item) => item.title === "Cluster");
	assert.equal(cluster?.url, "/servers/srv1/cluster");
	assert.equal(
		serverNav("srv1").some((item) => item.title === "Swarm"),
		false,
	);
	assert.equal(
		serverNav("srv1", { setUp: false }).some(
			(item) => item.title === "Cluster",
		),
		false,
	);
});

test("the request log is offered only to those the backend lets read it", () => {
	// lib/permissions.ts for a member and an admin, as far as Activity asks.
	const role = (admin: boolean) =>
		({
			deployment: { read: true },
			docker: { read: admin },
			organization: { update: admin },
		}) as Parameters<typeof canReadRequests>[0];
	assert.equal(canReadRequests(role(false)), false);
	assert.equal(canReadRequests(role(true)), true);
	// Servers alone (a custom role) isn't enough: the backend asks for the role.
	assert.equal(
		canReadRequests({
			...role(false),
			docker: { read: true },
		} as Parameters<typeof canReadRequests>[0]),
		false,
	);
	const titles = (admin: boolean) =>
		visibleItems(activityNav, role(admin)).map((item) => item.title);
	assert.deepEqual(titles(false), ["Deployments"]);
	assert.deepEqual(titles(true), ["Deployments", "Schedules", "Requests"]);
});
