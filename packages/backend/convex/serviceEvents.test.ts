import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	grantMember,
	markDeployed,
	setup,
	type TestConvex,
} from "./test.setup";

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	const alice = asUser(t, "alice");
	const { environmentId } = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "Web",
	});
	const serverId = await t.run((ctx) =>
		ctx.db.insert("servers", {
			organizationId: "org1",
			name: "edge",
			ipAddress: "10.0.0.9",
			port: 22,
			username: "root",
			serverType: "deploy",
			buildsConcurrency: 1,
			enableDockerCleanup: false,
		}),
	);
	const applicationId = await alice.mutation(
		api.applications.applications.create,
		{ environmentId, name: "Web", serverId },
	);
	const app = { kind: "application" as const, id: applicationId as string };
	return { t, alice, environmentId, serverId, applicationId, app };
};

const eventsOf = async (
	t: TestConvex,
	target: { kind: "application" | "compose" | "database"; id: string },
) =>
	(
		await asUser(t, "alice").query(api.serviceEvents.list, {
			target,
			paginationOpts: { numItems: 100, cursor: null },
		})
	).page;

type JobSpec = Doc<"jobs">["spec"];
type JobStatus = Doc<"jobs">["status"];

// A job as the queue writes it, plus its deployment row for deploy-like
// kinds. `startedAt` marks when the agent claimed it.
const addJob = (
	t: TestConvex,
	group: string,
	spec: JobSpec,
	state: { status: JobStatus; startedAt?: number },
	target?: { kind: string; id: string },
) =>
	t.run(async (ctx) => {
		const jobId = await ctx.db.insert("jobs", {
			organizationId: "org1",
			partition: "local",
			group,
			spec,
			status: state.status,
			attempts: 0,
			maxAttempts: 1,
			idempotent: false,
			cancelRequested: false,
			startedAt: state.startedAt,
		});
		if (target) {
			await ctx.db.insert("deployments", {
				organizationId: "org1",
				jobId,
				target,
				title: "Manual deployment",
			});
		}
		return jobId;
	});

const now = (t: TestConvex) => t.run(async () => Date.now());

const appJob = async (
	t: TestConvex,
	applicationId: Id<"applications">,
	spec:
		| { kind: "application.deploy" }
		| { kind: "application.redeploy"; rebuild: boolean }
		| { kind: "application.reload" }
		| { kind: "application.rollback"; rollbackId: Id<"applicationRollbacks"> },
	status: JobStatus,
) => {
	// Within one millisecond convex-test orders documents by fractions of it,
	// so start jobs on a fresh millisecond to keep edits before them applied.
	await new Promise((resolve) => setTimeout(resolve, 2));
	return addJob(
		t,
		`application:${applicationId}`,
		{ ...spec, applicationId } as JobSpec,
		{
			status,
			startedAt: status === "queued" ? undefined : await now(t),
		},
		spec.kind === "application.reload"
			? undefined
			: { kind: "application", id: applicationId },
	);
};

const deploymentOf = (t: TestConvex, jobId: Id<"jobs">) =>
	t.run(async (ctx) => {
		const row = await ctx.db
			.query("deployments")
			.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
			.first();
		if (!row) throw new Error("no deployment");
		return row._id;
	});

const addRollback = (
	t: TestConvex,
	applicationId: Id<"applications">,
	fields: Partial<Doc<"applicationRollbacks">>,
) =>
	t.run((ctx) =>
		ctx.db.insert("applicationRollbacks", {
			organizationId: "org1",
			applicationId,
			version: 1,
			image: "web:v1",
			localTag: "web:v1",
			...fields,
		}),
	);

const pendingTypes = async (
	t: TestConvex,
	target: { kind: "application" | "compose" | "database"; id: string },
) => {
	const pending = await asUser(t, "alice").query(
		api.serviceEvents.pendingChanges,
		{ target },
	);
	return pending.events.map((e) => e.type);
};

describe("service events", () => {
	test("env edits record variable names and never values", async () => {
		const { t, alice, applicationId, app } = await seed();
		await alice.action(api.applications.applications.saveEnvironment, {
			applicationId,
			env: "API_URL=https://first.example\nDB_PASSWORD=hunter2-secret\nKEEP=same",
		});
		await alice.action(api.applications.applications.saveEnvironment, {
			applicationId,
			env: "DB_PASSWORD=rotated-secret-value\nKEEP=same\nNEW_FLAG=on",
		});
		const events = (await eventsOf(t, app)).filter(
			(event) => event.type === "config.env",
		);
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({
			actorId: "alice",
			appliesOnDeploy: true,
			details: {
				fields: ["env"],
				added: ["NEW_FLAG"],
				removed: ["API_URL"],
				changed: ["DB_PASSWORD"],
			},
		});
		expect(events[1]?.details?.added).toEqual([
			"API_URL",
			"DB_PASSWORD",
			"KEEP",
		]);
		const stored = JSON.stringify(
			await t.run((ctx) => ctx.db.query("serviceEvents").collect()),
		);
		for (const value of [
			"hunter2-secret",
			"rotated-secret-value",
			"https://first.example",
			"same",
			"=on",
		]) {
			expect(stored).not.toContain(value);
		}
	});

	test("preview-only env edits are not staged for the next deploy", async () => {
		const { t, alice, applicationId, app } = await seed();
		await alice.action(api.applications.applications.saveEnvironment, {
			applicationId,
			previewEnv: "PREVIEW_TOKEN=abc",
		});
		const [event] = (await eventsOf(t, app)).filter(
			(e) => e.type === "config.env",
		);
		expect(event).toMatchObject({
			appliesOnDeploy: false,
			details: { fields: ["previewEnv"], added: ["PREVIEW_TOKEN"] },
		});
	});

	test("records settings, domains, ports, mounts and lifecycle by area", async () => {
		const { t, alice, applicationId, app } = await seed();
		await alice.mutation(api.applications.applications.update, {
			applicationId,
			name: "Web 2",
			memoryLimit: "512m",
			replicas: 2,
			autoDeploy: false,
		});
		await alice.mutation(api.infra.domains.create, {
			owner: app,
			host: "app.example.com",
			https: true,
			certificateType: "letsencrypt",
			port: 3000,
		});
		await alice.mutation(api.infra.ports.create, {
			owner: app,
			publishedPort: 8080,
			targetPort: 80,
			protocol: "tcp",
			publishMode: "ingress",
		});
		await alice.mutation(api.applications.mounts.create, {
			applicationId,
			mount: { type: "volume", volumeName: "data", mountPath: "/data" },
		});
		await markDeployed(t, "applications", applicationId);
		await alice.mutation(api.applications.deploy.stop, { applicationId });
		const events = await eventsOf(t, app);
		const byType = Object.fromEntries(events.map((e) => [e.type, e]));
		expect(byType["config.rename"]).toMatchObject({
			summary: "Renamed from Web to Web 2",
			appliesOnDeploy: false,
		});
		expect(byType["config.resources"]).toMatchObject({
			details: { fields: ["memoryLimit"] },
			appliesOnDeploy: true,
		});
		expect(byType["config.advanced"]?.details?.fields).toEqual(["replicas"]);
		expect(byType["config.general"]).toMatchObject({
			details: { fields: ["autoDeploy"] },
			appliesOnDeploy: false,
		});
		// Application domains are Traefik files, applied right away.
		expect(byType["config.domains"]).toMatchObject({
			details: { host: "app.example.com", action: "create" },
			appliesOnDeploy: false,
		});
		expect(byType["config.ports"]).toMatchObject({
			details: { port: 8080, action: "create" },
			appliesOnDeploy: true,
		});
		expect(byType["config.mounts"]).toMatchObject({
			details: { path: "/data", action: "create" },
			appliesOnDeploy: true,
		});
		expect(byType["lifecycle.stop"]).toMatchObject({ actorId: "alice" });
		expect(byType["lifecycle.created"]).toBeDefined();
		expect(events[0]?.type).toBe("lifecycle.stop");
	});

	test("compose domains wait for the next deploy", async () => {
		const { t, alice, environmentId } = await seed();
		const composeId = await alice.mutation(api.compose.crud.create, {
			environmentId,
			name: "Stack",
			composeFile: "services:\n  web:\n    image: nginx:alpine\n",
		});
		const compose = { kind: "compose" as const, id: composeId as string };
		await alice.mutation(api.infra.domains.create, {
			owner: compose,
			host: "stack.example.com",
			https: false,
			certificateType: "none",
			port: 80,
			serviceName: "web",
		});
		await alice.mutation(api.compose.crud.saveFile, {
			composeId,
			composeFile: "services:\n  web:\n    image: nginx:1.27\n",
		});
		const pending = await alice.query(api.serviceEvents.pendingChanges, {
			target: compose,
		});
		expect(pending.deployState).toBe("never");
		expect(pending.events.map((e) => e.type)).toEqual([
			"config.composeFile",
			"config.domains",
		]);
	});

	test("database passwords and env are recorded without values", async () => {
		const { t, alice, environmentId } = await seed();
		const databaseId = await alice.action(api.databases.databases.create, {
			environmentId,
			name: "db",
			engine: "postgres",
			databasePassword: "initial-password-1",
		});
		await alice.action(api.databases.passwords.changePassword, {
			databaseId,
			password: "Another-password-2",
		});
		await alice.action(api.databases.databases.setEnv, {
			databaseId,
			env: "PGTZ=UTC",
		});
		const events = await eventsOf(t, { kind: "database", id: databaseId });
		expect(events.map((e) => e.type)).toEqual([
			"config.env",
			"config.password",
			"lifecycle.created",
		]);
		const stored = JSON.stringify(events);
		expect(stored).not.toContain("password-");
		expect(stored).not.toContain("UTC");
	});

	test("only a successful deploy applies staged changes", async () => {
		const { t, alice, applicationId, app } = await seed();
		await alice.mutation(api.applications.applications.saveBuildType, {
			applicationId,
			type: "nixpacks",
		});
		let pending = await alice.query(api.serviceEvents.pendingChanges, {
			target: app,
		});
		expect(pending).toMatchObject({ deployState: "never", count: 1 });

		await appJob(t, applicationId, { kind: "application.deploy" }, "failed");
		await appJob(t, applicationId, { kind: "application.deploy" }, "cancelled");
		expect(await pendingTypes(t, app)).toEqual(["config.build"]);

		// A deploy in flight doesn't clear anything until it succeeds.
		const jobId = await appJob(
			t,
			applicationId,
			{ kind: "application.deploy" },
			"running",
		);
		pending = await alice.query(api.serviceEvents.pendingChanges, {
			target: app,
		});
		expect(pending).toMatchObject({ deployState: "deploying", count: 1 });

		await t.run((ctx) => ctx.db.patch("jobs", jobId, { status: "succeeded" }));
		const startedAt = (await t.run((ctx) => ctx.db.get("jobs", jobId)))
			?.startedAt;
		pending = await alice.query(api.serviceEvents.pendingChanges, {
			target: app,
		});
		expect(pending).toMatchObject({
			deployState: "deployed",
			since: startedAt,
			count: 0,
		});

		await alice.mutation(api.applications.mounts.create, {
			applicationId,
			mount: { type: "volume", volumeName: "data", mountPath: "/data" },
		});
		await alice.mutation(api.applications.applications.update, {
			applicationId,
			description: "not staged",
		});
		expect(await pendingTypes(t, app)).toEqual(["config.mounts"]);
		const counts = await alice.query(api.serviceEvents.pendingChangeCounts, {
			organizationId: "org1",
			targets: [app, { kind: "compose", id: "missing" }],
		});
		expect(counts).toMatchObject([
			{ pendingChangeCount: 1, hasMore: false, primaryAction: "reload" },
			null,
		]);

		// A rollback to a version that can't be dated (no stored cutoffs, no
		// deployment) changes nothing.
		const rollbackId = await t.run((ctx) =>
			ctx.db.insert("applicationRollbacks", {
				organizationId: "org1",
				applicationId,
				version: 1,
				image: "web:v1",
				localTag: "web:v1",
			}),
		);
		await appJob(
			t,
			applicationId,
			{ kind: "application.rollback", rollbackId },
			"succeeded",
		);
		expect(await pendingTypes(t, app)).toEqual(["config.mounts"]);
	});

	test("a successful reload applies runtime settings but not build changes", async () => {
		const { t, alice, applicationId, app } = await seed();
		await appJob(t, applicationId, { kind: "application.deploy" }, "succeeded");
		await alice.action(api.applications.applications.saveEnvironment, {
			applicationId,
			env: "API_URL=https://api.example",
			buildArgs: "NODE_VERSION=22",
			buildSecrets: "",
		});
		await alice.mutation(api.applications.applications.saveBuildType, {
			applicationId,
			type: "nixpacks",
		});
		await alice.mutation(api.applications.mounts.create, {
			applicationId,
			mount: { type: "volume", volumeName: "data", mountPath: "/data" },
		});
		await alice.mutation(api.applications.applications.update, {
			applicationId,
			memoryLimit: "512m",
			replicas: 2,
		});
		const env = (await eventsOf(t, app)).filter((e) => e.type === "config.env");
		expect(env.map((e) => [e.details?.fields, e.reapply]).sort()).toEqual([
			[["buildArgs", "buildSecrets"], "build"],
			[["env"], "spec"],
		]);
		const everything = [
			"config.advanced",
			"config.resources",
			"config.mounts",
			"config.build",
			"config.env",
			"config.env",
		];
		expect(await pendingTypes(t, app)).toEqual(everything);

		await appJob(t, applicationId, { kind: "application.reload" }, "failed");
		expect(await pendingTypes(t, app)).toEqual(everything);

		await appJob(t, applicationId, { kind: "application.reload" }, "succeeded");
		const pending = await alice.query(api.serviceEvents.pendingChanges, {
			target: app,
		});
		expect(pending.events.map((e) => e.type)).toEqual([
			"config.build",
			"config.env",
		]);
		expect(pending.events.find((e) => e.type === "config.env")).toMatchObject({
			details: { fields: ["buildArgs", "buildSecrets"] },
		});
		expect(pending.reloadedSince).toBeGreaterThan(pending.since ?? 0);

		// A redeploy without rebuild only re-applies the spec, like a reload;
		// a rebuild also applies build settings.
		await appJob(
			t,
			applicationId,
			{ kind: "application.redeploy", rebuild: false },
			"succeeded",
		);
		expect(await pendingTypes(t, app)).toHaveLength(2);
		await appJob(
			t,
			applicationId,
			{ kind: "application.redeploy", rebuild: true },
			"succeeded",
		);
		expect(await pendingTypes(t, app)).toEqual([]);
	});

	test("reloads and lifecycle jobs never apply compose changes", async () => {
		const { t, alice, environmentId } = await seed();
		const composeId = await alice.mutation(api.compose.crud.create, {
			environmentId,
			name: "Stack",
			composeFile: "services:\n  web:\n    image: nginx:alpine\n",
		});
		const compose = { kind: "compose" as const, id: composeId as string };
		await alice.mutation(api.compose.crud.saveFile, {
			composeId,
			composeFile: "services:\n  web:\n    image: nginx:1.27\n",
		});
		const group = `compose:${composeId}`;
		const at = await now(t);
		await addJob(
			t,
			group,
			{ kind: "compose.start", composeId },
			{
				status: "succeeded",
				startedAt: at,
			},
		);
		await addJob(
			t,
			group,
			{ kind: "compose.stop", composeId },
			{
				status: "succeeded",
				startedAt: at,
			},
		);
		await addJob(
			t,
			group,
			{ kind: "compose.deploy", composeId },
			{ status: "failed", startedAt: at },
			compose,
		);
		expect(await pendingTypes(t, compose)).toEqual(["config.composeFile"]);
		await addJob(
			t,
			group,
			{ kind: "compose.deploy", composeId },
			{ status: "succeeded", startedAt: await now(t) },
			compose,
		);
		expect(await pendingTypes(t, compose)).toEqual([]);
	});

	test("database reloads and lifecycle jobs apply nothing; deploys do", async () => {
		const { t, alice, environmentId } = await seed();
		const databaseId = await alice.action(api.databases.databases.create, {
			environmentId,
			name: "db",
			engine: "postgres",
			databasePassword: "initial-password-1",
		});
		const database = { kind: "database" as const, id: databaseId as string };
		await alice.action(api.databases.databases.setEnv, {
			databaseId,
			env: "PGTZ=UTC",
		});
		const group = `postgres:${databaseId}`;
		await addJob(
			t,
			group,
			{ kind: "databases.reload", databaseId },
			{
				status: "succeeded",
				startedAt: await now(t),
			},
		);
		// Backups, restores and lifecycle jobs have deployment rows too.
		await addJob(
			t,
			group,
			{ kind: "databases.start", databaseId },
			{ status: "succeeded", startedAt: await now(t) },
			database,
		);
		expect(await pendingTypes(t, database)).toEqual(["config.env"]);
		await addJob(
			t,
			group,
			{ kind: "databases.deploy", databaseId },
			{ status: "succeeded", startedAt: await now(t) },
			database,
		);
		expect(await pendingTypes(t, database)).toEqual([]);
	});

	test("primaryAction is the lightest action that ships every change", async () => {
		const { t, alice, applicationId, app } = await seed();
		await t.run((ctx) =>
			ctx.db.patch("applications", applicationId, {
				source: { type: "docker", image: "nginx:alpine" },
			}),
		);
		await alice.mutation(api.applications.applications.saveBuildType, {
			applicationId,
			type: "nixpacks",
		});
		// Nothing runs yet, so only a deploy applies anything.
		let pending = await alice.query(api.serviceEvents.pendingChanges, {
			target: app,
		});
		expect(pending).toMatchObject({
			primaryAction: "deploy",
			actionCounts: { reload: 0, rebuild: 0, deploy: 1 },
		});
		expect(pending.events.map((e) => e.action)).toEqual(["deploy"]);

		await appJob(t, applicationId, { kind: "application.deploy" }, "succeeded");
		pending = await alice.query(api.serviceEvents.pendingChanges, {
			target: app,
		});
		expect(pending).toMatchObject({ count: 0, primaryAction: null });
		expect(
			await alice.mutation(api.serviceEvents.applyPending, { target: app }),
		).toBeNull();

		await alice.mutation(api.applications.mounts.create, {
			applicationId,
			mount: { type: "volume", volumeName: "data", mountPath: "/data" },
		});
		await alice.action(api.applications.applications.saveEnvironment, {
			applicationId,
			env: "API_URL=https://api.example",
		});
		pending = await alice.query(api.serviceEvents.pendingChanges, {
			target: app,
		});
		expect(pending).toMatchObject({
			primaryAction: "reload",
			actionCounts: { reload: 2, rebuild: 0, deploy: 0 },
		});
		expect(
			await alice.query(api.serviceEvents.pendingChangeCounts, {
				organizationId: "org1",
				targets: [app],
			}),
		).toMatchObject([
			{ pendingChangeCount: 2, hasMore: false, primaryAction: "reload" },
		]);

		await alice.mutation(api.applications.applications.saveBuildType, {
			applicationId,
			type: "dockerfile",
		});
		pending = await alice.query(api.serviceEvents.pendingChanges, {
			target: app,
		});
		expect(pending.primaryAction).toBe("rebuild");

		await alice.mutation(api.applications.patches.save, {
			owner: app,
			filePath: "a.txt",
			content: "x",
		});
		pending = await alice.query(api.serviceEvents.pendingChanges, {
			target: app,
		});
		expect(pending).toMatchObject({
			primaryAction: "deploy",
			actionCounts: { reload: 2, rebuild: 1, deploy: 1 },
		});
		expect(pending.events.map((e) => [e.type, e.action])).toEqual([
			["config.patches", "deploy"],
			["config.build", "rebuild"],
			["config.env", "reload"],
			["config.mounts", "reload"],
		]);

		// Same permission checks as calling deploy directly.
		await expect(
			asUser(t, "mallory").mutation(api.serviceEvents.applyPending, {
				target: app,
			}),
		).rejects.toThrow();
		const started = await alice.mutation(api.serviceEvents.applyPending, {
			target: app,
		});
		expect(started?.action).toBe("deploy");
		const job = await t.run((ctx) =>
			ctx.db.get("jobs", started?.jobId as Id<"jobs">),
		);
		expect(job?.spec).toMatchObject({ kind: "application.deploy" });
	});

	test("applyPending starts a reload when only runtime settings changed", async () => {
		const { t, alice, applicationId, app } = await seed();
		await appJob(t, applicationId, { kind: "application.deploy" }, "succeeded");
		await alice.mutation(api.applications.applications.update, {
			applicationId,
			memoryLimit: "512m",
		});
		const started = await alice.mutation(api.serviceEvents.applyPending, {
			target: app,
		});
		expect(started?.action).toBe("reload");
		const job = await t.run((ctx) =>
			ctx.db.get("jobs", started?.jobId as Id<"jobs">),
		);
		expect(job?.spec).toMatchObject({ kind: "application.reload" });
	});

	test("compose and databases only offer a deploy", async () => {
		const { t, alice, environmentId } = await seed();
		const composeId = await alice.mutation(api.compose.crud.create, {
			environmentId,
			name: "Stack",
			composeFile: "services:\n  web:\n    image: nginx:alpine\n",
		});
		const compose = { kind: "compose" as const, id: composeId as string };
		await addJob(
			t,
			`compose:${composeId}`,
			{ kind: "compose.deploy", composeId },
			{ status: "succeeded", startedAt: await now(t) },
			compose,
		);
		await alice.mutation(api.compose.crud.saveFile, {
			composeId,
			composeFile: "services:\n  web:\n    image: nginx:1.27\n",
		});
		const pending = await alice.query(api.serviceEvents.pendingChanges, {
			target: compose,
		});
		expect(pending).toMatchObject({
			primaryAction: "deploy",
			actionCounts: { reload: 0, rebuild: 0, deploy: 1 },
		});
		expect(pending.events.map((e) => e.action)).toEqual(["deploy"]);
		const started = await alice.mutation(api.serviceEvents.applyPending, {
			target: compose,
		});
		expect(started?.action).toBe("deploy");
		expect(
			(await t.run((ctx) => ctx.db.get("jobs", started?.jobId as Id<"jobs">)))
				?.spec,
		).toMatchObject({ kind: "compose.deploy" });

		const databaseId = await alice.action(api.databases.databases.create, {
			environmentId,
			name: "db",
			engine: "postgres",
			databasePassword: "initial-password-1",
		});
		const database = { kind: "database" as const, id: databaseId as string };
		await alice.action(api.databases.databases.setEnv, {
			databaseId,
			env: "PGTZ=UTC",
		});
		expect(
			await alice.query(api.serviceEvents.pendingChangeCounts, {
				organizationId: "org1",
				targets: [compose, database],
			}),
		).toMatchObject([
			{ pendingChangeCount: 1, hasMore: false, primaryAction: "deploy" },
			{ pendingChangeCount: 1, hasMore: false, primaryAction: "deploy" },
		]);
		const dbStarted = await alice.mutation(api.serviceEvents.applyPending, {
			target: database,
		});
		expect(
			(await t.run((ctx) => ctx.db.get("jobs", dbStarted?.jobId as Id<"jobs">)))
				?.spec,
		).toMatchObject({ kind: "databases.deploy" });
	});

	test("a successful rollback re-opens changes recorded since its version", async () => {
		const { t, alice, applicationId, app } = await seed();
		await alice.mutation(api.applications.applications.saveBuildType, {
			applicationId,
			type: "nixpacks",
		});
		const v1 = await appJob(
			t,
			applicationId,
			{ kind: "application.deploy" },
			"succeeded",
		);
		await alice.mutation(api.applications.mounts.create, {
			applicationId,
			mount: { type: "volume", volumeName: "data", mountPath: "/data" },
		});
		await appJob(t, applicationId, { kind: "application.deploy" }, "succeeded");
		await alice.mutation(api.applications.applications.update, {
			applicationId,
			memoryLimit: "512m",
		});
		expect(await pendingTypes(t, app)).toEqual(["config.resources"]);

		const rollbackId = await addRollback(t, applicationId, {
			deploymentId: await deploymentOf(t, v1),
		});
		await appJob(
			t,
			applicationId,
			{ kind: "application.rollback", rollbackId },
			"failed",
		);
		expect(await pendingTypes(t, app)).toEqual(["config.resources"]);

		const rollbackJob = await appJob(
			t,
			applicationId,
			{ kind: "application.rollback", rollbackId },
			"succeeded",
		);
		const pending = await alice.query(api.serviceEvents.pendingChanges, {
			target: app,
		});
		expect(pending.events.map((e) => e.type)).toEqual([
			"config.resources",
			"config.mounts",
		]);
		expect(pending).toMatchObject({
			primaryAction: "reload",
			rolledBackAt: (await t.run((ctx) => ctx.db.get("jobs", rollbackJob)))
				?.startedAt,
		});

		// A later job applies them again as usual.
		await appJob(t, applicationId, { kind: "application.reload" }, "succeeded");
		expect(await pendingTypes(t, app)).toEqual([]);
	});

	test("a rollback restores the cutoffs stored with its version", async () => {
		const { t, alice, applicationId, app } = await seed();
		const startOf = async (jobId: Id<"jobs">) =>
			(await t.run((ctx) => ctx.db.get("jobs", jobId)))?.startedAt ?? null;
		const deployed = await startOf(
			await appJob(
				t,
				applicationId,
				{ kind: "application.deploy" },
				"succeeded",
			),
		);
		await alice.mutation(api.applications.applications.saveBuildType, {
			applicationId,
			type: "nixpacks",
		});
		const redeployed = await startOf(
			await appJob(
				t,
				applicationId,
				{ kind: "application.redeploy", rebuild: false },
				"succeeded",
			),
		);
		// Version 2 came from an image-only redeploy: its image predates the
		// build change, so rolling back to it leaves that change pending.
		const appliedAt = { deploy: deployed, build: deployed, spec: redeployed };
		const rollbackId = await addRollback(t, applicationId, {
			version: 2,
			appliedAt,
		});
		await alice.mutation(api.applications.applications.saveBuildType, {
			applicationId,
			type: "dockerfile",
		});
		await appJob(
			t,
			applicationId,
			{ kind: "application.redeploy", rebuild: true },
			"succeeded",
		);
		expect(await pendingTypes(t, app)).toEqual([]);

		const { jobId } = await alice.mutation(
			api.applications.rollbacks.rollback,
			{ rollbackId },
		);
		expect((await t.run((ctx) => ctx.db.get("jobs", jobId)))?.spec).toEqual({
			kind: "application.rollback",
			applicationId,
			rollbackId,
			appliedAt,
			trusted: true,
		});
		await t.run(async (ctx) =>
			ctx.db.patch("jobs", jobId, {
				status: "succeeded",
				startedAt: Date.now(),
			}),
		);
		// The row going away doesn't matter: the job carries the cutoffs.
		await alice.mutation(api.applications.rollbacks.remove, { rollbackId });
		expect(await pendingTypes(t, app)).toEqual([
			"config.build",
			"config.build",
		]);
	});

	test("members only see services they were given", async () => {
		const { t, applicationId, app } = await seed();
		const mallory = asUser(t, "mallory");
		await expect(
			mallory.query(api.serviceEvents.list, {
				target: app,
				paginationOpts: { numItems: 10, cursor: null },
			}),
		).rejects.toThrow(/access to this service/);
		await expect(
			asUser(t, "eve").query(api.serviceEvents.pendingChanges, { target: app }),
		).rejects.toThrow(/Not a member/);
		expect(
			await mallory.query(api.serviceEvents.pendingChangeCounts, {
				organizationId: "org1",
				targets: [app],
			}),
		).toEqual([null]);
		const feed = await mallory.query(api.serviceEvents.listForOrganization, {
			organizationId: "org1",
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(feed.page).toEqual([]);

		await grantMember(t, "org1", "mallory", { services: [applicationId] });
		const page = await mallory.query(api.serviceEvents.list, {
			target: app,
			paginationOpts: { numItems: 10, cursor: null },
		});
		expect(page.page.map((e) => e.type)).toEqual(["lifecycle.created"]);
	});

	test("agent runtime reports coalesce crash loops per service", async () => {
		const { t, serverId, app } = await seed();
		const agentId = await addAgent(t);
		const agent = asAgent(t, agentId);
		const now = await t.run(async () => Date.now());
		const crash = (exitCode: number, count = 1) => ({
			target: app,
			type: "runtime.crashed" as const,
			exitCode,
			container: "app-web.1.abc",
			at: now,
			count,
		});
		await expect(
			asUser(t, "alice").mutation(api.serviceEvents.reportRuntime, {
				serverId,
				events: [crash(1)],
			}),
		).rejects.toThrow(/Agent authentication/);
		expect(
			await agent.mutation(api.serviceEvents.reportRuntime, {
				serverId,
				events: [crash(1), crash(137, 2)],
			}),
		).toBe(2);
		// Wrong server (e.g. a container left behind after a transfer).
		expect(
			await agent.mutation(api.serviceEvents.reportRuntime, {
				events: [crash(1)],
			}),
		).toBe(0);
		await agent.mutation(api.serviceEvents.reportRuntime, {
			serverId,
			events: [{ ...crash(0), type: "runtime.oomKilled" }],
		});
		const runtime = (await eventsOf(t, app)).filter((e) =>
			e.type.startsWith("runtime."),
		);
		expect(runtime).toHaveLength(2);
		expect(runtime[1]).toMatchObject({
			type: "runtime.crashed",
			summary: "Container exited with code 137 (3 times)",
			details: { exitCode: 137, count: 3, container: "app-web.1.abc" },
			appliesOnDeploy: false,
		});
		expect(runtime[0]).toMatchObject({
			type: "runtime.oomKilled",
			summary: "Container killed: out of memory",
		});
		expect(runtime[0]?.actorId).toBeUndefined();
	});

	test("watch targets need an agent and include the panel host", async () => {
		const { t, serverId } = await seed();
		await expect(
			asUser(t, "alice").query(api.serviceEvents.watchTargets, {}),
		).rejects.toThrow(/Agent authentication/);
		const agent = asAgent(t, await addAgent(t));
		// The seeded server has no SSH key, so only the panel host is watched.
		expect(await agent.query(api.serviceEvents.watchTargets, {})).toEqual([
			{ serverId: null, target: { type: "local" } },
		]);
		expect(serverId).toBeDefined();
	});

	test("activity names the job a service is busy with, running first", async () => {
		const { t, alice, applicationId, app } = await seed();
		const read = () =>
			alice.query(api.serviceEvents.pendingChanges, { target: app });
		expect((await read()).activity).toBeNull();

		// Housekeeping in the service's group is not something it is busy with.
		await addJob(
			t,
			`application:${applicationId}`,
			{ kind: "infra.routingSync", owner: app } as JobSpec,
			{ status: "queued" },
		);
		expect((await read()).activity).toBeNull();

		await markDeployed(t, "applications", applicationId);
		const stopId = await alice.mutation(api.applications.deploy.stop, {
			applicationId,
		});
		expect((await read()).activity).toEqual({
			kind: "stopping",
			status: "queued",
			jobId: stopId,
			cancelRequested: false,
			waiting: 0,
		});

		const deployId = await appJob(
			t,
			applicationId,
			{ kind: "application.deploy" },
			"running",
		);
		expect((await read()).activity).toMatchObject({
			kind: "deploying",
			status: "running",
			jobId: deployId,
			waiting: 1,
		});

		const [counts] = await alice.query(api.serviceEvents.pendingChangeCounts, {
			organizationId: "org1",
			targets: [app],
		});
		expect(counts).toMatchObject({
			deployState: "deploying",
			deployed: false,
			activity: { kind: "deploying", status: "running" },
		});

		await alice.mutation(api.jobs.cancel, { jobId: deployId });
		expect((await read()).activity).toMatchObject({
			jobId: deployId,
			cancelRequested: true,
		});
	});

	test("prune drops events past the retention window", async () => {
		vi.useFakeTimers();
		try {
			const { t, app } = await seed();
			expect(await t.mutation(internal.serviceEvents.prune, {})).toBe(0);
			expect(await eventsOf(t, app)).toHaveLength(1);
			vi.setSystemTime(Date.now() + 91 * 24 * 60 * 60 * 1000);
			expect(await t.mutation(internal.serviceEvents.prune, {})).toBe(1);
			expect(await eventsOf(t, app)).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
