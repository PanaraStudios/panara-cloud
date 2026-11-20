import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	addMember,
	asUser,
	grantMember,
	setup,
	type TestConvex,
} from "../test.setup";
import { detectCdn } from "./domains";
import { registerRoutingOwner } from "./routing";

const app = { kind: "application" as const, id: "app1" };

const seed = async (withServer = true) => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	const serverId = withServer
		? ((await t.run((ctx) =>
				ctx.db.insert("servers", {
					organizationId: "org1",
					name: "web",
					ipAddress: "203.0.113.7",
					port: 22,
					username: "root",
					serverType: "deploy",
					buildsConcurrency: 1,
					enableDockerCleanup: true,
				}),
			)) as Id<"servers">)
		: undefined;
	await t.run((ctx) =>
		registerRoutingOwner(ctx, {
			organizationId: "org1",
			owner: app,
			serverId,
			appName: "app-app1",
		}),
	);
	return t;
};

const dnsAnswer = (records: Record<string, string[]>) =>
	vi.fn(async (url: string) => {
		const type = new URL(url).searchParams.get("type") ?? "A";
		const code = type === "A" ? 1 : 28;
		return new Response(
			JSON.stringify({
				Answer: (records[type] ?? []).map((data) => ({ type: code, data })),
			}),
			{ status: 200 },
		);
	});

const setPanelIp = (t: TestConvex, serverIp?: string) =>
	t.run((ctx) =>
		ctx.db.insert("webServerSettings", {
			key: "instance" as const,
			serverIp,
			https: false,
			certificateType: "none" as const,
			enableDockerCleanup: false,
			cleanupCacheApplications: false,
			cleanupCacheOnPreviews: false,
			cleanupCacheOnCompose: false,
		}),
	);

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("domain helpers for the UI", () => {
	test("serverIp is the server's address, or the panel's", async () => {
		const t = await seed();
		await expect(
			asUser(t, "mallory").query(api.infra.domains.serverIp, { owner: app }),
		).rejects.toThrow(/access to this service/);
		await grantMember(t, "org1", "mallory", { services: [app.id] });
		expect(
			await asUser(t, "mallory").query(api.infra.domains.serverIp, {
				owner: app,
			}),
		).toBe("203.0.113.7");

		const panel = await seed(false);
		expect(
			await asUser(panel, "alice").query(api.infra.domains.serverIp, {
				owner: app,
			}),
		).toBeNull();
		await setPanelIp(panel, "198.51.100.1");
		expect(
			await asUser(panel, "alice").query(api.infra.domains.serverIp, {
				owner: app,
			}),
		).toBe("198.51.100.1");
	});

	test("serverIp rejects other organizations", async () => {
		const t = await seed();
		await expect(
			asUser(t, "eve").query(api.infra.domains.serverIp, { owner: app }),
		).rejects.toThrow(/Not a member/);
	});

	test("validateHost compares DNS answers with the server address", async () => {
		const t = await seed();
		const alice = asUser(t, "alice");

		vi.stubGlobal("fetch", dnsAnswer({ A: ["203.0.113.7"] }));
		expect(
			await alice.action(api.infra.domains.validateHost, {
				owner: app,
				host: "app.example.com",
			}),
		).toEqual({ isValid: true, resolvedIp: "203.0.113.7", error: undefined });

		vi.stubGlobal("fetch", dnsAnswer({ A: ["192.0.2.1"] }));
		const wrong = await alice.action(api.infra.domains.validateHost, {
			owner: app,
			host: "app.example.com",
		});
		expect(wrong.isValid).toBe(false);
		expect(wrong.error).toMatch(/should point to 203.0.113.7/);

		vi.stubGlobal("fetch", dnsAnswer({ A: ["104.16.1.1"] }));
		const cdn = await alice.action(api.infra.domains.validateHost, {
			owner: app,
			host: "app.example.com",
		});
		expect(cdn).toMatchObject({ isValid: true, cdnProvider: "Cloudflare" });

		vi.stubGlobal("fetch", dnsAnswer({}));
		const missing = await alice.action(api.infra.domains.validateHost, {
			owner: app,
			host: "app.example.com",
		});
		expect(missing).toMatchObject({ isValid: false });
	});

	test("validateHost requires membership", async () => {
		const t = await seed();
		vi.stubGlobal("fetch", dnsAnswer({ A: ["203.0.113.7"] }));
		await expect(
			asUser(t, "eve").action(api.infra.domains.validateHost, {
				owner: app,
				host: "app.example.com",
			}),
		).rejects.toThrow(/Not a member/);
	});

	test("detectCdn matches provider ranges only", () => {
		expect(detectCdn("151.101.1.1")?.name).toBe("Fastly");
		expect(detectCdn("8.8.8.8")).toBeNull();
		expect(detectCdn("2606:4700::1")).toBeNull();
	});
});
