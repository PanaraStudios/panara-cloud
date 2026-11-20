import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, setup, type TestConvex } from "../test.setup";
import { invitationEmailArgs } from "./email";
import {
	buildChannelRequest,
	buildMessage,
	buildTestMessage,
	invitationEmail,
	normalizeCredentials,
	renderEmailHtml,
} from "./lib/notificationMessages";

const noEvents = {
	appDeploy: false,
	appBuildError: false,
	databaseBackup: false,
	volumeBackup: false,
	dockerCleanup: false,
	serverThreshold: false,
	panelRestart: false,
	panelBackup: false,
};

const buildError = {
	type: "appBuildError" as const,
	projectName: "Shop",
	applicationName: "web",
	applicationType: "application",
	errorMessage: "exit code 1",
	buildLink: "https://panel.test/build/1",
};

type FetchCall = { url: string; init: RequestInit };

let calls: FetchCall[];
let respond: (url: string) => Response;

beforeEach(() => {
	calls = [];
	respond = () => new Response("ok", { status: 200 });
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, init: init ?? {} });
			return respond(url);
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

const bodyOf = (call: FetchCall) => JSON.parse(String(call.init.body));

const createSlack = (
	t: TestConvex,
	organizationId: string,
	user: string,
	webhookUrl: string,
	events: Partial<typeof noEvents>,
) =>
	asUser(t, user).action(api.platform.notifications.create, {
		organizationId,
		name: "slack",
		channel: { type: "slack", channel: "#deploys" },
		events: { ...noEvents, ...events },
		credentials: { webhookUrl },
	});

const runScheduled = (t: TestConvex) =>
	t.finishAllScheduledFunctions(vi.runAllTimers);

describe("notifications", () => {
	test("only admins read and write, outsiders get nothing", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org1", "bob", "member");
		await addMember(t, "org2", "mallory", "owner");
		const notificationId = await createSlack(
			t,
			"org1",
			"alice",
			"https://hooks.slack.test/a",
			{ appDeploy: true },
		);

		await expect(
			asUser(t, "alice").query(api.platform.notifications.list, {
				organizationId: "org1",
			}),
		).resolves.toHaveLength(1);
		await expect(
			asUser(t, "bob").query(api.platform.notifications.list, {
				organizationId: "org1",
			}),
		).rejects.toThrow(/notification\.read permission/);
		await expect(
			createSlack(t, "org1", "bob", "https://hooks.slack.test/b", {}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
		await expect(
			asUser(t, "bob").mutation(api.platform.notifications.remove, {
				notificationId,
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);

		const mallory = asUser(t, "mallory");
		await expect(
			mallory.query(api.platform.notifications.get, { notificationId }),
		).rejects.toThrow(/Not a member/);
		await expect(
			mallory.action(api.platform.notifications.update, {
				notificationId,
				name: "pwned",
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			mallory.mutation(api.platform.notifications.remove, { notificationId }),
		).rejects.toThrow(/Not a member/);
		await expect(
			mallory.action(api.platform.notifications.test, { notificationId }),
		).rejects.toThrow(/Not a member/);
		await expect(
			t.query(api.platform.notifications.list, { organizationId: "org1" }),
		).rejects.toThrow(/Not authenticated/);
		expect(calls).toHaveLength(0);
	});

	test("credentials are encrypted and never returned", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		const alice = asUser(t, "alice");
		const slackId = await createSlack(
			t,
			"org1",
			"alice",
			"https://hooks.slack.test/SECRET-WEBHOOK",
			{},
		);
		await alice.action(api.platform.notifications.create, {
			organizationId: "org1",
			name: "mail",
			channel: {
				type: "email",
				smtpServer: "smtp.test",
				smtpPort: 587,
				username: "bot",
				fromAddress: "bot@panara-cloud.test",
				toAddresses: ["ops@panara-cloud.test"],
			},
			events: noEvents,
			credentials: { password: "SECRET-PASSWORD" },
		});

		const docs = await t.run((ctx) => ctx.db.query("notifications").collect());
		const secrets = await t.run((ctx) => ctx.db.query("secrets").collect());
		const listed = await alice.query(api.platform.notifications.list, {
			organizationId: "org1",
		});
		const one = await alice.query(api.platform.notifications.get, {
			notificationId: slackId,
		});
		for (const value of [docs, secrets, listed, one]) {
			expect(JSON.stringify(value)).not.toMatch(/SECRET-/);
		}
		expect(secrets).toHaveLength(2);
		expect(secrets.every((s) => s.kind === "platform.notification")).toBe(true);
		expect(one).toMatchObject({ hasCredentials: true });

		await alice.mutation(api.platform.notifications.remove, {
			notificationId: slackId,
		});
		expect(
			await t.run((ctx) => ctx.db.query("secrets").collect()),
		).toHaveLength(1);
	});

	test("update keeps stored credentials unless replaced or the type changes", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		const alice = asUser(t, "alice");
		const notificationId = await createSlack(
			t,
			"org1",
			"alice",
			"https://hooks.slack.test/original",
			{},
		);
		const load = () =>
			t.query(internal.platform.notifications.loadForDelivery, {
				notificationId,
			});

		await alice.action(api.platform.notifications.update, {
			notificationId,
			name: "renamed",
			channel: { type: "slack", channel: "#ops" },
			events: { ...noEvents, appDeploy: true },
		});
		expect(await load()).toMatchObject({
			name: "renamed",
			channel: { type: "slack", channel: "#ops" },
			credentials: { webhookUrl: "https://hooks.slack.test/original" },
		});

		await alice.action(api.platform.notifications.update, {
			notificationId,
			credentials: { webhookUrl: "https://hooks.slack.test/rotated" },
		});
		expect((await load())?.credentials.webhookUrl).toBe(
			"https://hooks.slack.test/rotated",
		);

		await expect(
			alice.action(api.platform.notifications.update, {
				notificationId,
				channel: { type: "telegram", chatId: "42" },
			}),
		).rejects.toThrow(/botToken/);
	});

	test("dispatch fans out only to matching notifications of the organization", async () => {
		vi.useFakeTimers();
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		await addMember(t, "org2", "mallory", "owner");
		await createSlack(t, "org1", "alice", "https://hooks.slack.test/one", {
			appBuildError: true,
		});
		await asUser(t, "alice").action(api.platform.notifications.create, {
			organizationId: "org1",
			name: "discord",
			channel: { type: "discord", decoration: true },
			events: { ...noEvents, appBuildError: true },
			credentials: { webhookUrl: "https://discord.test/hook" },
		});
		await createSlack(t, "org1", "alice", "https://hooks.slack.test/off", {
			appDeploy: true,
		});
		await createSlack(t, "org2", "mallory", "https://hooks.slack.test/org2", {
			appBuildError: true,
		});

		const fanned = await t.mutation(internal.platform.notifications.dispatch, {
			organizationId: "org1",
			event: buildError,
		});
		expect(fanned).toBe(2);
		await runScheduled(t);

		expect(calls.map((c) => c.url).sort()).toEqual([
			"https://discord.test/hook",
			"https://hooks.slack.test/one",
		]);
		const slack = bodyOf(
			calls.find((c) => c.url.includes("slack")) as FetchCall,
		);
		expect(slack).toMatchObject({
			channel: "#deploys",
			attachments: [{ color: "#FF0000", pretext: ":warning: *Build Failed*" }],
		});
		expect(JSON.stringify(slack)).toContain("exit code 1");
		const discord = bodyOf(
			calls.find((c) => c.url.includes("discord")) as FetchCall,
		);
		expect(discord.embeds[0]).toMatchObject({
			title: "> `⚠️` Build Failed",
			color: 0xed4245,
		});
	});

	test("a failing channel does not stop the others", async () => {
		vi.useFakeTimers();
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		await createSlack(t, "org1", "alice", "https://hooks.slack.test/down", {
			dockerCleanup: true,
		});
		await createSlack(t, "org1", "alice", "https://hooks.slack.test/up", {
			dockerCleanup: true,
		});
		respond = (url) =>
			new Response("nope", { status: url.endsWith("down") ? 500 : 200 });
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		await t.mutation(internal.platform.notifications.dispatch, {
			organizationId: "org1",
			event: { type: "dockerCleanup", message: "freed 2GB" },
		});
		await runScheduled(t);
		expect(calls).toHaveLength(2);
		expect(errors).toHaveBeenCalledWith(expect.stringContaining("500"));
		errors.mockRestore();
	});

	test("panel events only reach the root organization", async () => {
		vi.useFakeTimers();
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		await addMember(t, "org2", "mallory", "owner");
		await createSlack(t, "org1", "alice", "https://hooks.slack.test/1", {
			panelRestart: true,
		});
		await createSlack(t, "org2", "mallory", "https://hooks.slack.test/2", {
			panelRestart: true,
		});
		await createSlack(t, "org1", "alice", "https://hooks.slack.test/3", {
			panelBackup: true,
		});
		await t.mutation(internal.platform.notifications.dispatch, {
			organizationId: null,
			event: { type: "panelRestart" },
		});
		await runScheduled(t);
		expect(calls.map((c) => c.url).sort()).toEqual([
			"https://hooks.slack.test/1",
		]);
		await expect(
			t.mutation(internal.platform.notifications.dispatch, {
				organizationId: null,
				event: buildError,
			}),
		).rejects.toThrow(/requires an organizationId/);
	});

	test("test-send works for saved and unsaved configurations", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org1", "bob", "member");
		await asUser(t, "alice").action(api.platform.notifications.test, {
			organizationId: "org1",
			channel: { type: "telegram", chatId: "42" },
			credentials: { botToken: "123:abc" },
		});
		expect(calls[0]?.url).toBe(
			"https://api.telegram.org/bot123:abc/sendMessage",
		);
		expect(bodyOf(calls[0] as FetchCall)).toMatchObject({
			chat_id: "42",
			parse_mode: "HTML",
		});
		expect(bodyOf(calls[0] as FetchCall).text).toContain(
			"Hi, From Panara Cloud",
		);
		await expect(
			asUser(t, "bob").action(api.platform.notifications.test, {
				organizationId: "org1",
				channel: { type: "telegram", chatId: "42" },
				credentials: { botToken: "123:abc" },
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);

		const notificationId = (await createSlack(
			t,
			"org1",
			"alice",
			"https://hooks.slack.test/saved",
			{},
		)) as Id<"notifications">;
		respond = () => new Response("bad", { status: 404 });
		await expect(
			asUser(t, "alice").action(api.platform.notifications.test, {
				notificationId,
			}),
		).rejects.toThrow(/Error testing the notification/);
		expect(calls.at(-1)?.url).toBe("https://hooks.slack.test/saved");
	});

	test("rejects cloud metadata endpoints", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await expect(
			asUser(t, "alice").action(api.platform.notifications.test, {
				organizationId: "org1",
				channel: { type: "custom", endpoint: "http://169.254.169.254/latest" },
				credentials: {},
			}),
		).rejects.toThrow(/private or internal network/);
		expect(calls).toHaveLength(0);
	});
});

describe("notification messages", () => {
	const sentAt = Date.UTC(2026, 0, 2, 3, 4, 5);

	test("ntfy uses bearer auth, tags and a view action", () => {
		const request = buildChannelRequest(
			{
				type: "ntfy",
				serverUrl: "https://ntfy.test/",
				topic: "ops",
				priority: 4,
			},
			{ accessToken: "tk" },
			buildMessage(buildError, sentAt),
		);
		expect(request).toMatchObject({
			kind: "fetch",
			url: "https://ntfy.test/ops",
			init: {
				headers: {
					Authorization: "Bearer tk",
					"X-Priority": "4",
					"X-Title": "Build Failed",
					"X-Tags": "warning",
					"X-Actions":
						"view, View Build Details, https://panel.test/build/1, clear=true;",
				},
			},
		});
	});

	test("pushover emergency priority sends retry and expire", () => {
		const request = buildChannelRequest(
			{ type: "pushover", priority: 2, retry: 60, expire: 600 },
			{ userKey: "u", apiToken: "a" },
			buildTestMessage(sentAt),
		);
		if (request.kind !== "fetch") throw new Error("expected fetch");
		const form = new URLSearchParams(String(request.init.body));
		expect(Object.fromEntries(form)).toMatchObject({
			token: "a",
			user: "u",
			priority: "2",
			retry: "60",
			expire: "600",
		});
	});

	test("email channel becomes an SMTP request with the HTML template", () => {
		const request = buildChannelRequest(
			{
				type: "email",
				smtpServer: "smtp.test",
				smtpPort: 465,
				username: "bot",
				fromAddress: "bot@panara-cloud.test",
				toAddresses: ["a@panara-cloud.test"],
			},
			{ password: "pw" },
			buildMessage(
				{
					type: "databaseBackup",
					projectName: "Shop",
					applicationName: "db",
					databaseType: "postgres",
					databaseName: "shop",
					status: "error",
					errorMessage: "<disk full>",
				},
				sentAt,
			),
		);
		expect(request).toMatchObject({
			kind: "smtp",
			host: "smtp.test",
			port: 465,
			subject: "Database backup for Panara Cloud",
		});
		if (request.kind !== "smtp") throw new Error("expected smtp");
		expect(request.html).toContain("&lt;disk full&gt;");
		expect(request.html).toContain("2026-01-02 03:04:05 UTC");
	});

	test("custom webhooks get the standard payload and headers", () => {
		const request = buildChannelRequest(
			{ type: "custom", endpoint: "https://hooks.test/x" },
			{ headers: '{"X-Token":"t"}' },
			buildMessage(
				{
					type: "appDeploy",
					projectName: "Shop",
					applicationName: "web",
					applicationType: "application",
					environmentName: "production",
					buildLink: "https://panel.test/b",
					domains: ["a.test", "b.test"],
				},
				sentAt,
			),
		);
		if (request.kind !== "fetch") throw new Error("expected fetch");
		expect(request.init.headers).toMatchObject({ "X-Token": "t" });
		expect(JSON.parse(String(request.init.body))).toMatchObject({
			title: "Build Success",
			status: "success",
			type: "build",
			domains: "a.test, b.test",
		});
	});

	test("credential validation", () => {
		expect(() => normalizeCredentials("pushover", { userKey: "u" })).toThrow(
			/apiToken/,
		);
		expect(() =>
			normalizeCredentials("custom", { headers: '["not","object"]' }),
		).toThrow(/JSON object/);
		expect(
			normalizeCredentials("ntfy", { accessToken: " ", stray: "x" }),
		).toEqual({});
	});

	test("html escaping and invitation email", () => {
		expect(
			renderEmailHtml({
				preview: "p",
				heading: "<script>",
				intro: "i",
				details: [],
			}),
		).not.toContain("<script>");
		const args = invitationEmailArgs(
			{
				id: "inv 1",
				email: "new@panara-cloud.test",
				organization: { name: "Acme" },
				inviter: { user: { name: "Alice", email: "alice@panara-cloud.test" } },
			},
			"https://panel.test/",
		);
		expect(args.inviteLink).toBe("https://panel.test/invitation?token=inv%201");
		const mail = invitationEmail(args);
		expect(mail.subject).toBe(
			"You've been invited to join Acme on Panara Cloud",
		);
		expect(mail.html).toContain("https://panel.test/invitation?token=inv%201");
		expect(mail.html).toContain("<strong>Alice</strong>");
		expect(mail.text).toContain("new@panara-cloud.test");
	});
});
