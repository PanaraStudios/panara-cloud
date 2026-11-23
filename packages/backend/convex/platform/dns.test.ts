import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { addMember, asUser, setup } from "../test.setup";

const API_TOKEN = "cf-secret-token";

type CfRecord = {
	id: string;
	type: string;
	name: string;
	content: string;
	ttl: number;
	proxied?: boolean;
};

// A tiny in-memory Cloudflare API.
const mockCloudflare = () => {
	const zones = [
		{ id: "z-example", name: "example.com" },
		{ id: "z-sub", name: "apps.example.com" },
	];
	const records = new Map<string, CfRecord[]>([
		["z-example", []],
		["z-sub", []],
	]);
	let nextId = 1;
	const writes: string[] = [];
	const ok = (result: unknown) =>
		Response.json({ success: true, errors: [], result });

	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
			const url = new URL(String(input));
			const headers = init.headers as Record<string, string>;
			if (headers.Authorization !== `Bearer ${API_TOKEN}`) {
				return Response.json(
					{ success: false, errors: [{ message: "Invalid token" }] },
					{ status: 403 },
				);
			}
			const path = url.pathname.replace("/client/v4", "");
			const method = init.method ?? "GET";
			if (path === "/zones") return ok(zones);
			const match = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(path);
			const zoneRecords = match ? records.get(match[1] as string) : undefined;
			if (!match || !zoneRecords) {
				return Response.json({ success: false, errors: [] }, { status: 404 });
			}
			const recordId = match[2];
			if (method === "GET") {
				const type = url.searchParams.get("type");
				const name = url.searchParams.get("name");
				return ok(
					zoneRecords.filter(
						(r) => (!type || r.type === type) && (!name || r.name === name),
					),
				);
			}
			const body = init.body ? JSON.parse(String(init.body)) : {};
			writes.push(`${method} ${match[1]}${recordId ? `/${recordId}` : ""}`);
			if (method === "POST") {
				const record = { id: `r${nextId++}`, ...body };
				zoneRecords.push(record);
				return ok(record);
			}
			const index = zoneRecords.findIndex((r) => r.id === recordId);
			if (method === "PUT") {
				zoneRecords[index] = { id: recordId as string, ...body };
				return ok(zoneRecords[index]);
			}
			zoneRecords.splice(index, 1);
			return ok({ id: recordId });
		}),
	);
	return { records, writes };
};

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "admin");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "mallory", "owner");
	const alice = asUser(t, "alice");
	const dnsProviderId = await alice.action(api.platform.dnsActions.create, {
		organizationId: "org1",
		name: "cf",
		providerType: "cloudflare",
		config: { apiToken: API_TOKEN },
	});
	return { t, alice, dnsProviderId };
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("dns providers", () => {
	test("api token is encrypted and masked", async () => {
		const { t, alice } = await seed();
		const docs = await t.run(async (ctx) => ({
			providers: await ctx.db.query("dnsProviders").collect(),
			secrets: await ctx.db.query("secrets").collect(),
		}));
		expect(JSON.stringify(docs)).not.toContain(API_TOKEN);
		const list = await alice.query(api.platform.dns.list, {
			organizationId: "org1",
		});
		expect(list).toMatchObject([{ config: { apiToken: "********" } }]);
		expect(JSON.stringify(list)).not.toContain(API_TOKEN);
	});

	test("get treats malformed and unknown ids as not found", async () => {
		const { t, alice, dnsProviderId } = await seed();
		await expect(
			alice.query(api.platform.dns.get, { dnsProviderId: "not-an-id" }),
		).resolves.toBeNull();
		const otherTableId = await t.run((ctx) =>
			ctx.db.insert("memberships", {
				memberId: "org1:zed",
				organizationId: "org1",
				userId: "zed",
				role: "member",
			}),
		);
		await expect(
			alice.query(api.platform.dns.get, { dnsProviderId: otherTableId }),
		).resolves.toBeNull();
		await expect(
			asUser(t, "mallory").query(api.platform.dns.get, { dnsProviderId }),
		).rejects.toThrow(/Not a member/);
	});

	test("members have no DNS access; other orgs are denied", async () => {
		const { t, alice, dnsProviderId } = await seed();
		mockCloudflare();
		const bob = asUser(t, "bob");
		await expect(
			bob.action(api.platform.dnsActions.listZones, { dnsProviderId }),
		).rejects.toThrow(/dnsProvider\.read permission/);
		await expect(
			bob.query(api.platform.dns.list, { organizationId: "org1" }),
		).rejects.toThrow(/dnsProvider\.read permission/);
		await expect(
			alice.action(api.platform.dnsActions.listZones, { dnsProviderId }),
		).resolves.toEqual([
			{ id: "z-example", name: "example.com" },
			{ id: "z-sub", name: "apps.example.com" },
		]);
		await expect(
			bob.action(api.platform.dnsActions.createRecord, {
				dnsProviderId,
				zoneId: "z-example",
				type: "A",
				name: "www.example.com",
				content: "1.2.3.4",
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
		await expect(
			asUser(t, "mallory").action(api.platform.dnsActions.listZones, {
				dnsProviderId,
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			t.action(internal.platform.dnsActions.upsertRecord, {
				organizationId: "org2",
				dnsProviderId,
				type: "A",
				name: "www.example.com",
				content: "1.2.3.4",
			}),
		).rejects.toThrow(/DNS provider not found/);
	});

	test("upsertRecord picks the longest matching zone and is idempotent", async () => {
		const { t, dnsProviderId } = await seed();
		const { records, writes } = mockCloudflare();
		const upsert = (content: string, replace?: boolean) =>
			t.action(internal.platform.dnsActions.upsertRecord, {
				organizationId: "org1",
				dnsProviderId,
				type: "A",
				name: "web.apps.example.com",
				content,
				proxied: false,
				replace,
			});

		const first = await upsert("10.0.0.1");
		expect(first.zoneId).toBe("z-sub");
		const second = await upsert("10.0.0.1");
		expect(second.id).toBe(first.id);
		expect(records.get("z-sub")).toHaveLength(1);

		const replaced = await upsert("10.0.0.2", true);
		expect(replaced.id).toBe(first.id);
		expect(records.get("z-sub")).toMatchObject([{ content: "10.0.0.2" }]);
		const writesBefore = writes.length;
		await upsert("10.0.0.2", true);
		expect(writes).toHaveLength(writesBefore);

		await expect(
			t.action(internal.platform.dnsActions.removeRecord, {
				organizationId: "org1",
				dnsProviderId,
				type: "A",
				name: "web.apps.example.com",
			}),
		).resolves.toBe(1);
		expect(records.get("z-sub")).toHaveLength(0);

		await expect(
			t.action(internal.platform.dnsActions.upsertRecord, {
				organizationId: "org1",
				dnsProviderId,
				type: "A",
				name: "www.elsewhere.org",
				content: "1.1.1.1",
			}),
		).rejects.toThrow(/No DNS zone found/);
	});

	test("provider errors surface as readable messages", async () => {
		const { t, alice } = await seed();
		mockCloudflare();
		await expect(
			alice.action(api.platform.dnsActions.testConnection, {
				organizationId: "org1",
				providerType: "cloudflare",
				config: { apiToken: "wrong" },
			}),
		).rejects.toThrow(
			/Cloudflare: request to \/zones\?per_page=1 failed: Invalid token/,
		);
		await expect(
			asUser(t, "bob").action(api.platform.dnsActions.testConnection, {
				organizationId: "org1",
				providerType: "cloudflare",
				config: { apiToken: "x" },
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
	});
});
