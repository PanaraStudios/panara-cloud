/// <reference types="vite/client" />
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import catalogJson from "../../api/catalog.json";
import { api, internal } from "../_generated/api";
import {
	API_KEY_NOT_ALLOWED,
	API_KEY_WRONG_ORGANIZATION,
	PEOPLE_AND_ACCESS_BY_KEY,
} from "../lib/access";
import schema from "../schema";
import {
	addMember,
	addServer,
	asApiKey,
	asUser,
	bootstrapAdmin,
	grantMember,
	setup,
	type TestConvex,
} from "../test.setup";
import { AI_SECRET_MASK } from "./lib/aiSettings";
import { convexPath, denyReason } from "./lib/apiPolicy";
import type { Catalog, CatalogFunction, ValidatorJson } from "./lib/apiSpec";

const catalog = catalogJson as Catalog;

// Probe values include URLs; nothing here may reach the network.
beforeEach(() => {
	vi.stubGlobal("fetch", async () => {
		throw new Error("No network in the scope tests");
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
});

// alice owns both organizations; the key under test belongs to org-a, and
// everything below lives in org-b.
const seed = async (t: TestConvex) => {
	await addMember(t, "org-a", "alice", "owner");
	await addMember(t, "org-b", "alice", "owner");
	const alice = asUser(t, "alice");
	const serverId = await addServer(t, "org-b");
	const { projectId, environmentId } = await alice.mutation(
		api.projects.create,
		{ organizationId: "org-b", name: "shop" },
	);
	await alice.mutation(api.applications.applications.create, {
		environmentId,
		name: "web",
		serverId,
	});
	await alice.mutation(api.compose.crud.create, {
		environmentId,
		name: "stack",
		serverId,
	});
	await alice.action(api.databases.databases.create, {
		environmentId,
		engine: "postgres",
		name: "db",
		appName: "db",
		databaseName: "shop",
		databaseUser: "shop",
		databasePassword: "S3cretPassw0rd",
		serverId,
	});
	await alice.mutation(api.platform.tags.create, {
		organizationId: "org-b",
		name: "prod",
	});
	return { projectId, environmentId, serverId };
};

type Synthesized = { value: unknown; pointsAtOrgB: boolean };
type Rows = Record<string, string>;

// Values that get past common argument checks (formats, lengths), so a
// function reaches its authorization instead of stopping at validation.
const PLAUSIBLE: [RegExp, string][] = [
	[/email/i, "probe@example.test"],
	[/^from$/i, "Probe <probe@example.test>"],
	[/url|endpoint/i, "https://example.com/probe"],
	[/domain|^host$|hostname/i, "probe.example.com"],
	[/cron|schedule/i, "0 3 * * *"],
	[/password|secret|token|apiKey/i, "S3cret-Passw0rd-probe"],
	[/ip$|^ip/i, "203.0.113.9"],
	[/path|directory/i, "/probe"],
	[/branch/i, "main"],
	[/image/i, "nginx:1.27"],
	[/port$/i, "8080"],
];
const plausible = (fieldName?: string) =>
	PLAUSIBLE.find(([pattern]) => fieldName && pattern.test(fieldName))?.[1] ??
	"probe";

// The smallest value a validator accepts, aimed at org-b wherever an
// organization id, a document id or a service id is asked for.
// `organizationId` names the organization put in organizationId fields:
// org-b aims everything at the other organization; the key's own org-a with
// org-b's resource ids is the shape a real attack takes, past the first
// check.
const synthesize = (
	validator: ValidatorJson,
	rows: Rows,
	fieldName?: string,
	organizationId = "org-b",
): Synthesized => {
	switch (validator.type) {
		case "null":
			return { value: null, pointsAtOrgB: false };
		case "number":
			return {
				value: fieldName && /port$/i.test(fieldName) ? 8080 : 1,
				pointsAtOrgB: false,
			};
		case "bigint":
			return { value: 1n, pointsAtOrgB: false };
		case "boolean":
			return { value: false, pointsAtOrgB: false };
		case "bytes":
			return { value: new ArrayBuffer(0), pointsAtOrgB: false };
		case "any":
			return { value: "x", pointsAtOrgB: false };
		case "string":
			if (fieldName === "organizationId") {
				return {
					value: organizationId,
					pointsAtOrgB: organizationId === "org-b",
				};
			}
			// Services are often referenced by a plain string id
			// (`owner: { kind, id }`, `serviceId`).
			return fieldName && /^(id|.*Id)$/.test(fieldName) && rows.applications
				? { value: rows.applications, pointsAtOrgB: true }
				: { value: plausible(fieldName), pointsAtOrgB: false };
		case "literal":
			return { value: validator.value, pointsAtOrgB: false };
		case "id": {
			const row = rows[validator.tableName];
			return row
				? { value: row, pointsAtOrgB: true }
				: { value: `99999;${validator.tableName}`, pointsAtOrgB: false };
		}
		case "array":
			return { value: [], pointsAtOrgB: false };
		case "record":
			return { value: {}, pointsAtOrgB: false };
		case "object": {
			const value: Record<string, unknown> = {};
			let pointsAtOrgB = false;
			for (const [name, field] of Object.entries(validator.value)) {
				const made = synthesize(field.fieldType, rows, name, organizationId);
				if (field.optional && !made.pointsAtOrgB) continue;
				value[name] = made.value;
				pointsAtOrgB ||= made.pointsAtOrgB;
			}
			return { value, pointsAtOrgB };
		}
		case "union": {
			const members = validator.value.map((member) =>
				synthesize(member, rows, fieldName, organizationId),
			);
			return (
				members.find((member) => member.pointsAtOrgB) ??
				members.find((member) => member.value !== null) ??
				members[0]
			);
		}
	}
};

const tableNames = Object.keys(schema.tables);

const rowsOfOrgB = (t: TestConvex): Promise<Rows> =>
	t.run(async (ctx) => {
		const rows: Rows = {};
		for (const table of tableNames) {
			const all = await (ctx.db as any).query(table).take(50);
			const row = all.find(
				(doc: { organizationId?: string }) => doc.organizationId === "org-b",
			);
			if (row) rows[table] = row._id;
		}
		return rows;
	});

// Gives org-b a row in every table that can hold one, built from the table's
// own validator, so functions that take a document id have something of
// org-b's to be pointed at. Tables that reference each other fill in over a
// few passes.
const fillOrgB = async (t: TestConvex): Promise<Rows> => {
	let rows = await rowsOfOrgB(t);
	for (let pass = 0; pass < 4; pass++) {
		for (const table of tableNames) {
			if (rows[table]) continue;
			const validator = (
				schema.tables as unknown as Record<
					string,
					{ validator: { json: ValidatorJson } }
				>
			)[table].validator.json;
			const made = synthesize(validator, rows);
			const doc = made.value as Record<string, unknown>;
			if (doc?.organizationId !== "org-b") continue;
			await t
				.run((ctx) => (ctx.db as any).insert(table, doc))
				.catch(() => undefined);
		}
		rows = await rowsOfOrgB(t);
	}
	return rows;
};

const snapshot = (t: TestConvex) =>
	t.run(async (ctx) => {
		const tables: Record<string, unknown[]> = {};
		for (const table of tableNames) {
			tables[table] = await (ctx.db as any).query(table).take(500);
		}
		return tables;
	});

const call = (
	t: ReturnType<typeof asApiKey>,
	fn: Pick<CatalogFunction, "name" | "kind">,
	args: Record<string, unknown>,
) => {
	const path = convexPath(fn.name);
	if (fn.kind === "query") {
		return t.query(makeFunctionReference<"query">(path), args);
	}
	if (fn.kind === "mutation") {
		return t.mutation(makeFunctionReference<"mutation">(path), args);
	}
	return t.action(makeFunctionReference<"action">(path), args);
};

const messageOf = (error: unknown): string => {
	const data = (error as { data?: unknown }).data;
	if (typeof data === "string") return data;
	return error instanceof Error ? error.message : String(error);
};

const isEmpty = (value: unknown): boolean =>
	value === null ||
	value === undefined ||
	value === false ||
	(Array.isArray(value) && value.length === 0);

describe("an API key stays inside its organization", () => {
	test("no served function reads or changes another organization of the same user", async () => {
		const t = setup();
		await seed(t);
		const rows = await fillOrgB(t);
		const before = await snapshot(t);
		const key = asApiKey(t, "alice", "org-a");

		const refused: string[] = [];
		const stoppedEarlier: string[] = [];
		const answered: string[] = [];
		for (const fn of catalog.functions) {
			const made = synthesize(fn.args, rows);
			if (!made.pointsAtOrgB) continue;
			try {
				const result = await call(
					key,
					fn,
					made.value as Record<string, unknown>,
				);
				if (!isEmpty(result)) {
					answered.push(`${fn.name}: ${JSON.stringify(result)}`);
				}
			} catch (error) {
				(messageOf(error).includes(API_KEY_WRONG_ORGANIZATION)
					? refused
					: stoppedEarlier
				).push(`${fn.name}: ${messageOf(error)}`);
			}
		}

		expect(answered).toEqual([]);
		expect(await snapshot(t)).toEqual(before);
		// Most functions get as far as the organization check. The rest stop
		// earlier, on their own argument checks, before reading anything.
		expect(refused.length).toBeGreaterThan(330);
		expect(stoppedEarlier.length).toBeLessThan(refused.length / 8);
	});

	test("the key's own organization with another organization's resource ids reaches nothing of it", async () => {
		const t = setup();
		await seed(t);
		await addServer(t, "org-a");
		await asUser(t, "alice").mutation(api.projects.create, {
			organizationId: "org-a",
			name: "own",
		});
		const rows = await fillOrgB(t);
		const orgBIds = Object.values(rows);
		const key = asApiKey(t, "alice", "org-a");

		const docsById = async () =>
			new Map(
				await t.run(async (ctx) => {
					const docs: [string, string][] = [];
					for (const table of tableNames) {
						for (const doc of await (ctx.db as any).query(table).take(500)) {
							docs.push([doc._id, JSON.stringify(doc)]);
						}
					}
					return docs;
				}),
			);
		const mentionsOrgB = (text: string, passed: string) =>
			text.includes('"org-b"') ||
			orgBIds.some((id) => text.includes(id) && !passed.includes(id));
		// A Git provider's OAuth client id is an opaque string the probe fills
		// with whatever an id-like field gets; storing it references nothing.
		const opaque = /"(clientId|applicationId)":"[^"]*"/g;
		const touchesOrgB = (text: string) => {
			const stripped = text.replace(opaque, "");
			return (
				stripped.includes('"org-b"') ||
				orgBIds.some((id) => stripped.includes(id))
			);
		};

		const leaked: string[] = [];
		const wrote: string[] = [];
		const stoppedEarlier: string[] = [];
		let probed = 0;
		let before = await docsById();
		for (const fn of catalog.functions) {
			const made = synthesize(fn.args, rows, undefined, "org-a");
			if (!made.pointsAtOrgB) continue;
			probed++;
			const passed = JSON.stringify(made.value);
			try {
				const result = await call(
					key,
					fn,
					made.value as Record<string, unknown>,
				);
				const text = JSON.stringify(result ?? null);
				if (mentionsOrgB(text, passed)) {
					leaked.push(`${fn.name}: ${text.slice(0, 300)}`);
				}
			} catch (error) {
				const message = messageOf(error);
				if (
					!message.includes(API_KEY_WRONG_ORGANIZATION) &&
					!/not found|does not belong|another organization|Not a member/i.test(
						message,
					)
				) {
					stoppedEarlier.push(`${fn.name}: ${message.slice(0, 120)}`);
				}
			}
			const after = await docsById();
			for (const [id, doc] of after) {
				if (before.get(id) !== doc && touchesOrgB(doc)) {
					wrote.push(`${fn.name}: ${doc.slice(0, 300)}`);
				}
			}
			for (const [id, doc] of before) {
				if (!after.has(id) && touchesOrgB(doc)) {
					wrote.push(`${fn.name} deleted ${doc.slice(0, 200)}`);
				}
			}
			before = after;
		}

		expect(leaked).toEqual([]);
		expect(wrote).toEqual([]);
		expect(probed).toBeGreaterThan(200);
		// The rest stop on their own argument checks before reading anything
		// of org-b; see the next test for the ones that validate first.
		expect(stoppedEarlier.length, stoppedEarlier.join("\n")).toBeLessThan(
			probed / 8,
		);
	}, 120_000);

	test("functions that check their arguments before their caller are probed with arguments that pass those checks", async () => {
		const t = setup();
		await seed(t);
		await addServer(t, "org-a");
		const rows = await fillOrgB(t);
		const storageId = await t.run((ctx) =>
			ctx.storage.store(new Blob(["probe"], { type: "application/zip" })),
		);
		const key = asApiKey(t, "alice", "org-a");
		const monitoring = {
			refreshRate: 5,
			port: 4500,
			retentionDays: 7,
			cronJob: "0 3 * * *",
			thresholds: { cpu: 80, memory: 80 },
			containers: { refreshRate: 5, include: [], exclude: [] },
		};
		const pem = (label: string) =>
			`-----BEGIN ${label}-----\nMIIBprobe\n-----END ${label}-----`;
		// Each with the key's own organization and org-b's resources, and with
		// org-b's organization outright.
		const cases: [string, Record<string, unknown>][] = [];
		for (const organizationId of ["org-a", "org-b"]) {
			cases.push(
				[
					"applications.deploy.dropDeploy",
					{ applicationId: rows.applications, storageId },
				],
				[
					"applications.patchRepo.requestFile",
					{ applicationId: rows.applications, path: "probe.txt" },
				],
				[
					"compose.hostOps.requestPatchFile",
					{ composeId: rows.compose, path: "probe.txt" },
				],
				[
					"infra.certificates.create",
					{
						organizationId,
						serverId: rows.servers,
						name: "probe",
						certificateData: pem("CERTIFICATE"),
						privateKey: pem("PRIVATE KEY"),
					},
				],
				[
					"live.monitoring.configure",
					{ organizationId, serverId: rows.servers, settings: monitoring },
				],
				[
					"live.monitoringHistory.history",
					{
						request: {
							kind: "containerStats",
							scope: {
								type: "host",
								organizationId,
								serverId: rows.servers,
							},
							target: { type: "all" },
						},
					},
				],
				[
					"live.monitoringHistory.history",
					{
						request: {
							kind: "containerStats",
							scope: {
								type: "service",
								serviceKind: "application",
								serviceId: rows.applications,
							},
							target: { type: "all" },
						},
					},
				],
				[
					"live.sandboxes.create",
					{ organizationId, serverId: rows.servers, template: "alpine" },
				],
				[
					"live.sandboxes.updateTimeout",
					{ sandboxId: rows.sandboxes, timeoutMs: 60_000 },
				],
				[
					"platform.projectTransferNode.importProject",
					{ organizationId, storageId, serverId: rows.servers },
				],
				[
					"platform.projectTransferNode.previewImport",
					{ organizationId, storageId },
				],
				[
					"sources.registries.create",
					{
						organizationId,
						registryName: "probe",
						username: "probe",
						password: "S3cret-Passw0rd-probe",
						registryUrl: "registry.example.com",
						serverId: rows.servers,
					},
				],
				[
					"sources.registries.test",
					{
						organizationId,
						registryUrl: "registry.example.com",
						username: "probe",
						password: "S3cret-Passw0rd-probe",
						serverId: rows.servers,
					},
				],
				[
					"platform.aiActions.listModels",
					{
						organizationId,
						apiUrl: "https://example.com/probe",
						apiKey: AI_SECRET_MASK,
						aiId: rows.aiSettings,
					},
				],
			);
			if (organizationId === "org-b") {
				cases.push(
					[
						"sshKeys.create",
						{
							organizationId,
							name: "probe",
							publicKey: "ssh-ed25519 AAAAprobe",
							privateKey: pem("OPENSSH PRIVATE KEY"),
						},
					],
					[
						"platform.notifications.create",
						{
							organizationId,
							name: "probe",
							channel: { type: "telegram", chatId: "1" },
							events: {
								appDeploy: true,
								appBuildError: false,
								databaseBackup: false,
								volumeBackup: false,
								dockerCleanup: false,
								serverThreshold: false,
								panelRestart: false,
								panelBackup: false,
							},
							credentials: { botToken: "probe" },
						},
					],
				);
			}
		}
		const before = await snapshot(t);
		const byName = new Map(catalog.functions.map((fn) => [fn.name, fn]));
		const outcomes: string[] = [];
		for (const [name, args] of cases) {
			const fn = byName.get(name);
			expect(fn, name).toBeDefined();
			if (!fn) continue;
			try {
				const result = await call(key, fn, args);
				outcomes.push(`${name} answered ${JSON.stringify(result)}`);
			} catch (error) {
				const message = messageOf(error);
				if (
					!/another organization|not found|Not a member|Requires|instance administrator/i.test(
						message,
					)
				) {
					outcomes.push(`${name}: ${message}`);
				}
			}
		}
		expect(outcomes).toEqual([]);
		expect(await snapshot(t)).toEqual(before);
	});

	test("the key works in its own organization and only there", async () => {
		const t = setup();
		const { projectId } = await seed(t);
		const keyA = asApiKey(t, "alice", "org-a");
		const keyB = asApiKey(t, "alice", "org-b");

		const own = await keyA.mutation(api.projects.create, {
			organizationId: "org-a",
			name: "mine",
		});
		expect(
			(await keyA.query(api.projects.list, { organizationId: "org-a" })).map(
				(project) => project.name,
			),
		).toEqual(["mine"]);

		await expect(
			keyA.query(api.projects.list, { organizationId: "org-b" }),
		).rejects.toThrow(API_KEY_WRONG_ORGANIZATION);
		// Organization resolved from the document, not from an argument.
		await expect(
			keyA.mutation(api.projects.update, { projectId, name: "taken" }),
		).rejects.toThrow(API_KEY_WRONG_ORGANIZATION);
		await expect(
			keyA.mutation(api.projects.remove, { projectId }),
		).rejects.toThrow(API_KEY_WRONG_ORGANIZATION);
		await expect(
			keyA.query(api.environments.list, { projectId }),
		).rejects.toThrow(API_KEY_WRONG_ORGANIZATION);
		await expect(
			keyB.mutation(api.projects.remove, { projectId: own.projectId }),
		).rejects.toThrow(API_KEY_WRONG_ORGANIZATION);

		expect(
			await keyB.query(api.projects.list, { organizationId: "org-b" }),
		).toMatchObject([{ name: "shop" }]);
		// The same user signed in reaches both.
		const alice = asUser(t, "alice");
		await alice.mutation(api.projects.update, { projectId, name: "renamed" });
		await alice.mutation(api.projects.update, {
			projectId: own.projectId,
			name: "renamed too",
		});
	});

	test("a key follows its user's role and membership", async () => {
		const t = setup();
		await addMember(t, "org-a", "olivia", "owner");
		await addMember(t, "org-a", "mia", "member");
		const mia = asApiKey(t, "mia", "org-a");
		await expect(
			mia.mutation(api.projects.create, { organizationId: "org-a", name: "x" }),
		).rejects.toThrow(/project\.create permission/);
		await expect(
			mia.query(api.account.members, { organizationId: "org-a" }),
		).rejects.toThrow(/admin role/);
		await expect(
			asApiKey(t, "stranger", "org-a").query(api.projects.list, {
				organizationId: "org-a",
			}),
		).rejects.toThrow(/Not a member/);
	});

	test("a token without its organization is no caller at all", async () => {
		const t = setup();
		await addMember(t, "org-a", "alice", "owner");
		const unscoped = t.withIdentity({
			subject: "alice",
			issuer: "http://site.test/api-key",
		});
		await expect(
			unscoped.query(api.projects.list, { organizationId: "org-a" }),
		).rejects.toThrow(/Not authenticated/);
	});
});

describe("instance-level operations with an API key", () => {
	// alice administers the instance; "root" is its root organization and
	// "side" another organization she also owns.
	const seedInstance = async (t: TestConvex) => {
		await addMember(t, "root", "alice", "owner");
		await addMember(t, "side", "alice", "owner");
		await addMember(t, "side", "sam", "member");
		await bootstrapAdmin(t, "alice", "alice@example.test");
	};

	test("only a key of the root organization carries them", async () => {
		const t = setup();
		await seedInstance(t);
		const side = asApiKey(t, "alice", "side");
		const root = asApiKey(t, "alice", "root");

		expect(await side.query(api.infra.webServer.isInstanceAdmin, {})).toBe(
			false,
		);
		expect(await root.query(api.infra.webServer.isInstanceAdmin, {})).toBe(
			true,
		);
		await expect(
			side.mutation(api.infra.webServer.updateServerIp, {
				serverIp: "203.0.113.9",
			}),
		).rejects.toThrow(/instance administrator/);
		await expect(
			side.mutation(api.platform.deployTargets.setRemoteServersOnly, {
				remoteServersOnly: true,
			}),
		).rejects.toThrow(/instance administrator/);
		await expect(
			side.mutation(api.databases.panelBackups.create, {
				destinationId: "99999;destinations" as never,
				schedule: "0 3 * * *",
				enabled: true,
			} as never),
		).rejects.toThrow();
		await expect(side.query(api.email.settings, {})).rejects.toThrow(
			/Only the instance administrator/,
		);
		await expect(
			side.mutation(api.users.removeAccount, { userId: "sam" }),
		).rejects.toThrow(PEOPLE_AND_ACCESS_BY_KEY);
		await expect(
			root.mutation(api.users.removeAccount, { userId: "sam" }),
		).rejects.toThrow(PEOPLE_AND_ACCESS_BY_KEY);

		await root.mutation(api.platform.deployTargets.setRemoteServersOnly, {
			remoteServersOnly: true,
		});
		expect(
			await side.query(api.platform.deployTargets.remoteServersOnly, {}),
		).toBe(true);
		expect(await root.query(api.email.settings, {})).toMatchObject({
			mode: expect.any(String),
		});
	});

	test("a root organization admin who is not the instance administrator gains nothing", async () => {
		const t = setup();
		await seedInstance(t);
		await addMember(t, "root", "rita", "member");
		const rita = asApiKey(t, "rita", "root");
		expect(await rita.query(api.infra.webServer.isInstanceAdmin, {})).toBe(
			false,
		);
		await expect(rita.query(api.email.settings, {})).rejects.toThrow(
			/Only the instance administrator/,
		);
	});
});

describe("instance-level functions the organization probes cannot reach", () => {
	// No organization or document id among their arguments, so the probes
	// above skip them. Expected outcome for a key of a non-root organization
	// (its owner is even the instance administrator) and for the root key.
	const instanceOnly: [string, Record<string, unknown>][] = [
		["databases.panelBackups.list", {}],
		["email.disconnect", {}],
		[
			"email.saveProvider",
			{
				provider: "resend",
				from: "Panara Cloud <no-reply@example.test>",
				apiKey: "re_probe_12345678",
			},
		],
		["email.sendTest", {}],
		["email.settings", {}],
		["infra.panel.runAction", { action: { type: "checkUpdate" } }],
		[
			"infra.webServer.assignDomain",
			{ host: "panel.example.test", https: false, certificateType: "none" },
		],
		["infra.webServer.getLocalBuildsConcurrency", {}],
		["infra.webServer.setLocalBuildsConcurrency", { buildsConcurrency: 2 }],
		[
			"infra.webServer.updateCacheCleanup",
			{
				cleanupCacheApplications: true,
				cleanupCacheOnPreviews: true,
				cleanupCacheOnCompose: true,
			},
		],
		["infra.webServer.updateServerIp", { serverIp: "203.0.113.9" }],
		[
			"platform.deployTargets.setRemoteServersOnly",
			{ remoteServersOnly: true },
		],
		[
			"platform.templates.setBaseUrl",
			{ baseUrl: "https://templates.example.test" },
		],
	];
	const anyCaller: [string, Record<string, unknown>, unknown][] = [
		["infra.webServer.isInstanceAdmin", {}, false],
		[
			"live.sandboxes.templates",
			{},
			expect.arrayContaining([expect.objectContaining({ name: "alpine" })]),
		],
		["platform.deployTargets.remoteServersOnly", {}, false],
		[
			"platform.schedules.previewNextRuns",
			{ cronExpression: "0 3 * * *", after: 0, count: 2 },
			[3 * 3600_000, 27 * 3600_000],
		],
		[
			"platform.settings.serverTime",
			{},
			expect.objectContaining({ time: expect.any(Number) }),
		],
		["platform.telemetry.availableTypes", {}, expect.any(Array)],
		["platform.templates.list", {}, expect.any(Array)],
		["platform.templates.tags", {}, expect.any(Array)],
		[
			"platform.templates.baseUrlSettings",
			{},
			expect.objectContaining({ canEdit: false }),
		],
	];
	const byName = new Map(catalog.functions.map((fn) => [fn.name, fn]));
	const fnOf = (name: string) => {
		const fn = byName.get(name);
		if (!fn) throw new Error(`${name} is not served`);
		return fn;
	};

	const seedInstance = async (t: TestConvex) => {
		await addMember(t, "root", "alice", "owner");
		await addMember(t, "side", "alice", "owner");
		await addMember(t, "side", "sam", "admin");
		await bootstrapAdmin(t, "alice", "alice@example.test");
	};

	test("a key of another organization gets the harmless facts and nothing else", async () => {
		const t = setup();
		await seedInstance(t);
		const before = await snapshot(t);
		for (const key of [
			asApiKey(t, "alice", "side"),
			asApiKey(t, "sam", "side"),
		]) {
			for (const [name, args] of instanceOnly) {
				await expect(call(key, fnOf(name), args), name).rejects.toThrow(
					/instance administrator/,
				);
			}
			for (const [name, args, expected] of anyCaller) {
				expect(await call(key, fnOf(name), args), name).toEqual(expected);
			}
		}
		expect(await snapshot(t)).toEqual(before);
	});

	test("the root organization's key reaches them", async () => {
		const t = setup();
		await seedInstance(t);
		const root = asApiKey(t, "alice", "root");
		expect(await call(root, fnOf("infra.webServer.isInstanceAdmin"), {})).toBe(
			true,
		);
		for (const [name, args] of instanceOnly) {
			if (name === "email.sendTest") {
				// Past the instance check; the test user has no sign-in account
				// to send to.
				await expect(call(root, fnOf(name), args)).rejects.toThrow(
					/Account not found/,
				);
				continue;
			}
			await call(root, fnOf(name), args);
		}
		expect(
			await call(root, fnOf("infra.webServer.getLocalBuildsConcurrency"), {}),
		).toBe(2);
		expect(
			await call(root, fnOf("platform.deployTargets.remoteServersOnly"), {}),
		).toBe(true);
	});
});

describe("instance facts for keys outside the root organization", () => {
	const seedTenants = async (t: TestConvex) => {
		await addMember(t, "root", "alice", "owner");
		await bootstrapAdmin(t, "alice", "alice@example.test");
		await addMember(t, "side", "sam", "admin");
		await addMember(t, "side", "mia", "member");
		await grantMember(t, "side", "mia", { flags: { canAccessToAPI: true } });
	};

	test("the panel's web settings: addresses for everyone, the rest for the instance administrator", async () => {
		const t = setup();
		await seedTenants(t);
		await asApiKey(t, "alice", "root").mutation(
			api.infra.webServer.assignDomain,
			{
				host: "panel.example.test",
				https: true,
				certificateType: "letsencrypt",
				letsEncryptEmail: "admin@example.test",
			},
		);
		await asApiKey(t, "alice", "root").mutation(
			api.infra.webServer.updateServerIp,
			{ serverIp: "203.0.113.9" },
		);
		for (const key of [
			asApiKey(t, "sam", "side"),
			asApiKey(t, "mia", "side"),
		]) {
			const seen = await key.query(api.infra.webServer.get, {});
			expect(seen).toMatchObject({
				serverIp: "203.0.113.9",
				host: "panel.example.test",
			});
			expect(seen.letsEncryptEmail).toBeUndefined();
			expect(JSON.stringify(seen)).not.toContain("admin@example.test");
		}
		expect(
			await asApiKey(t, "alice", "root").query(api.infra.webServer.get, {}),
		).toMatchObject({ letsEncryptEmail: "admin@example.test" });
	});

	test("members see a backup destination's name, not its bucket or keys", async () => {
		const t = setup();
		await seedTenants(t);
		const destinationId = await asUser(t, "sam").action(
			api.databases.destinations.create,
			{
				organizationId: "side",
				name: "offsite",
				provider: "AWS",
				accessKey: "AKIAPROBE",
				bucket: "side-backups",
				region: "eu-west-1",
				endpoint: "https://s3.example.test",
				additionalFlags: [],
				secretAccessKey: "secret-probe",
			},
		);
		const member = asApiKey(t, "mia", "side");
		const listed = await member.query(api.databases.destinations.list, {
			organizationId: "side",
		});
		expect(listed).toEqual([
			expect.objectContaining({ _id: destinationId, name: "offsite" }),
		]);
		const one = await member.query(api.databases.destinations.get, {
			destinationId,
		});
		for (const seen of [listed[0], one]) {
			expect(JSON.stringify(seen)).not.toMatch(
				/AKIAPROBE|side-backups|s3\.example/,
			);
		}
		expect(
			await asApiKey(t, "sam", "side").query(api.databases.destinations.get, {
				destinationId,
			}),
		).toMatchObject({ accessKey: "AKIAPROBE", bucket: "side-backups" });
	});

	test("refreshing the instance-wide template catalog needs the instance administrator", async () => {
		const t = setup();
		await seedTenants(t);
		for (const key of [
			asApiKey(t, "sam", "side"),
			asApiKey(t, "mia", "side"),
		]) {
			await expect(
				key.action(api.platform.templatesSync.refreshNow, {
					organizationId: "side",
				}),
			).rejects.toThrow(/instance administrator/);
		}
	});
});

describe("what a key may not do even past the gateway", () => {
	test("API keys, account and session functions refuse an API key identity", async () => {
		const t = setup();
		await addMember(t, "org-a", "alice", "owner");
		const key = asApiKey(t, "alice", "org-a");

		await expect(
			key.action(api.platform.apiKeys.create, {
				organizationId: "org-a",
				name: "another",
			}),
		).rejects.toThrow(API_KEY_NOT_ALLOWED);
		await expect(
			key.query(api.platform.apiKeys.list, { organizationId: "org-a" }),
		).rejects.toThrow(API_KEY_NOT_ALLOWED);
		await expect(key.query(api.platform.apiKeys.listMine, {})).rejects.toThrow(
			API_KEY_NOT_ALLOWED,
		);
		const { apiKeyId } = await asUser(t, "alice").action(
			api.platform.apiKeys.create,
			{ organizationId: "org-a", name: "ci" },
		);
		await expect(
			key.mutation(api.platform.apiKeys.revoke, { apiKeyId }),
		).rejects.toThrow(API_KEY_NOT_ALLOWED);

		await expect(
			key.mutation(api.account.generateAvatarUploadUrl, {}),
		).rejects.toThrow(API_KEY_NOT_ALLOWED);
		await expect(
			key.mutation(api.account.updateAvatar, { image: null }),
		).rejects.toThrow(API_KEY_NOT_ALLOWED);
		await expect(
			key.mutation(api.account.setDefaultOrganization, {
				organizationId: "org-a",
			}),
		).rejects.toThrow(API_KEY_NOT_ALLOWED);
		await expect(key.query(api.live.sessions.mine, {})).rejects.toThrow(
			API_KEY_NOT_ALLOWED,
		);
		await expect(
			key.mutation(api.platform.onboarding.complete, {}),
		).rejects.toThrow(API_KEY_NOT_ALLOWED);

		// These read the Better Auth session, which a key does not have.
		expect(await key.query(api.account.security, {})).toBeNull();
		expect(await key.query(api.account.organizations, {})).toBeNull();
		expect(await key.query(api.account.sessions, {})).toBeNull();
		expect(await key.query(api.auth.getCurrentUser, {})).toBeNull();
		await expect(
			key.mutation(api.account.revokeOtherSessions, {}),
		).rejects.toThrow(/Not signed in/);
		await expect(
			key.mutation(api.account.changeEmailWithoutConfirmation, {
				newEmail: "new@example.test",
			}),
		).rejects.toThrow(/Not signed in/);

		await expect(key.mutation(api.agent.hello, {} as never)).rejects.toThrow();
	});
});

describe("people and access are not managed with a key", () => {
	const grants = {
		accessedProjects: [],
		accessedEnvironments: [],
		accessedServices: [],
		canCreateProjects: true,
		canDeleteProjects: false,
		canCreateServices: false,
		canDeleteServices: false,
		canCreateEnvironments: false,
		canDeleteEnvironments: false,
		canAccessToTraefikFiles: false,
		canAccessToDocker: false,
		canAccessToAPI: true,
		canAccessToSSHKeys: false,
		canAccessToGitProviders: false,
	};

	// alice administers the instance and owns "root"; the keys under test
	// are hers (owner of the root organization, so every role and instance
	// check would pass) and an admin's.
	const seedPeople = async (t: TestConvex) => {
		await addMember(t, "root", "alice", "owner");
		await bootstrapAdmin(t, "alice", "alice@example.test");
		await addMember(t, "root", "adam", "admin");
		await addMember(t, "root", "mia", "member");
	};

	test("every function that creates, removes or changes people or their access refuses a key", async () => {
		for (const name of [
			"users.createWithCredentials",
			"users.invite",
			"users.passwordResetLink",
			"users.setDeactivated",
			"users.removeAccount",
			"account.removeInvitation",
			"permissions.assign",
		]) {
			expect(denyReason(name), name).toBe(PEOPLE_AND_ACCESS_BY_KEY);
		}
		const t = setup();
		await seedPeople(t);
		const before = await snapshot(t);
		for (const key of [
			asApiKey(t, "alice", "root"),
			asApiKey(t, "adam", "root"),
		]) {
			const refusals = [
				key.action(api.users.createWithCredentials, {
					organizationId: "root",
					email: "new@example.test",
					password: "a-long-enough-password",
					role: "admin",
				}),
				key.action(api.users.invite, {
					organizationId: "root",
					email: "new@example.test",
					role: "admin",
				}),
				key.action(api.users.passwordResetLink, {
					organizationId: "root",
					userId: "mia",
				}),
				key.mutation(api.users.setDeactivated, {
					organizationId: "root",
					userId: "mia",
					deactivated: true,
				}),
				key.mutation(api.users.setDeactivated, {
					organizationId: "root",
					userId: "mia",
					deactivated: false,
				}),
				key.mutation(api.users.removeAccount, { userId: "mia" }),
				key.mutation(api.account.removeInvitation, {
					organizationId: "root",
					invitationId: "x",
				}),
				key.mutation(api.permissions.assign, {
					organizationId: "root",
					userId: "mia",
					...grants,
				}),
			];
			for (const refusal of refusals) {
				await expect(refusal).rejects.toThrow(PEOPLE_AND_ACCESS_BY_KEY);
			}
		}
		expect(await snapshot(t)).toEqual(before);
	});

	test("the internal steps behind them refuse a key too", async () => {
		const t = setup();
		await seedPeople(t);
		const key = asApiKey(t, "alice", "root");
		await expect(
			key.mutation(internal.users.provision, {
				organizationId: "root",
				email: "new@example.test",
				role: "admin",
				passwordHash: "x",
			}),
		).rejects.toThrow(PEOPLE_AND_ACCESS_BY_KEY);
		await expect(
			key.mutation(internal.users.createInvitation, {
				organizationId: "root",
				email: "new@example.test",
				role: "admin",
			}),
		).rejects.toThrow(PEOPLE_AND_ACCESS_BY_KEY);
		await expect(
			key.mutation(internal.users.storePasswordResetToken, {
				organizationId: "root",
				userId: "mia",
				token: "t",
				expiresAt: Date.now() + 60_000,
			}),
		).rejects.toThrow(PEOPLE_AND_ACCESS_BY_KEY);
	});

	test("a key still reads the member list; a signed-in admin still changes access", async () => {
		const t = setup();
		await seedPeople(t);
		const key = asApiKey(t, "adam", "root");
		expect(
			await key.query(api.account.invitations, { organizationId: "root" }),
		).toEqual([]);
		expect(
			await key.query(api.permissions.forMember, {
				organizationId: "root",
				userId: "mia",
			}),
		).toMatchObject({ role: "member", canAccessToAPI: false });

		const adam = asUser(t, "adam");
		await adam.mutation(api.permissions.assign, {
			organizationId: "root",
			userId: "mia",
			...grants,
		});
		expect(
			await key.query(api.permissions.forMember, {
				organizationId: "root",
				userId: "mia",
			}),
		).toMatchObject({ canAccessToAPI: true, canCreateProjects: true });
	});
});
