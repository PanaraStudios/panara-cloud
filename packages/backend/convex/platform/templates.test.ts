import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { addMember, asUser, setup } from "../test.setup";
import { processTemplateToml } from "./lib/templateProcessors";
import { parseToml } from "./lib/toml";

const PLAUSIBLE_TOML = `[variables]
main_domain = "\${domain}"
secret_base = "\${base64:64}"
admin = "\${username}"

[[config.domains]]
serviceName = "plausible"
port = 8_000
host = "\${main_domain}"

[config.env]
BASE_URL = "http://\${main_domain}"
SECRET_KEY_BASE = "\${secret_base}"
APP = "\${APP_NAME}"
PORT = 8000

[[config.mounts]]
filePath = "/clickhouse/config.xml"
content = """
<host>\${main_domain}</host>
"""
`;

const meta = (ids: string[]) =>
	ids.map((id) => ({
		id,
		name: id.toUpperCase(),
		version: "1.0",
		description: `${id} service`,
		logo: `${id}.svg`,
		links: { github: `https://github.com/x/${id}`, website: "" },
		tags: id === "plausible" ? ["analytics"] : ["database"],
	}));

let routes: Record<string, () => Response>;
let fetched: string[];

const CATALOG = "https://catalog.example.org";

beforeEach(() => {
	process.env.TEMPLATES_BASE_URL = CATALOG;
	routes = {};
	fetched = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			fetched.push(url);
			return routes[url]?.() ?? new Response("not found", { status: 404 });
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.TEMPLATES_BASE_URL;
});

describe("toml parser", () => {
	test("parses the template.toml subset and the wider TOML grammar", () => {
		const parsed = parseToml(`# comment
title = 'literal \\n'
[a.b]
x = 1_000 # trailing
y = [1, 2,
  3,]
z = { k = "v", n.m = true }
s = """
line \\
  joined"""
[[list]]
v = 0x1F
[[list]]
v = -2.5e3
`);
		expect(parsed).toEqual({
			title: "literal \\n",
			a: {
				b: {
					x: 1000,
					y: [1, 2, 3],
					z: { k: "v", n: { m: true } },
					s: "line joined",
				},
			},
			list: [{ v: 31 }, { v: -2500 }],
		});
	});

	test("reports errors with a line number", () => {
		expect(() => parseToml("a = 1\na = 2")).toThrow(/defined twice \(line 2\)/);
		expect(() => parseToml('a = "open')).toThrow(/Unterminated string/);
		expect(() => parseToml("[t]\n[t]")).toThrow(/defined twice/);
	});
});

describe("template processing", () => {
	test("resolves variables, domains, env and mounts", async () => {
		const result = await processTemplateToml(
			PLAUSIBLE_TOML,
			"shop-plausible-abc123",
			{
				serverIp: "203.0.113.7",
				projectName: "shop-plausible",
			},
		);
		expect(result.domains).toHaveLength(1);
		const host = result.domains[0].host ?? "";
		expect(host).toMatch(/^shop-plausible-[0-9a-f]{6}-203-0-113-7\.sslip\.io$/);
		expect(result.domains[0]).toMatchObject({
			serviceName: "plausible",
			port: 8000,
		});
		expect(result.envs).toContain(`BASE_URL=http://${host}`);
		expect(result.envs).toContain("APP=shop-plausible-abc123");
		expect(result.envs).toContain("PORT=8000");
		const secret = result.envs.find((e) => e.startsWith("SECRET_KEY_BASE="));
		expect(atob(secret?.split("=").slice(1).join("=") ?? "")).toHaveLength(64);
		expect(result.mounts).toEqual([
			{ filePath: "/clickhouse/config.xml", content: `<host>${host}</host>\n` },
		]);
	});

	test("generates JWTs signed with a referenced secret", async () => {
		const result = await processTemplateToml(
			`[variables]
secret = "\${password:32}"
anon_payload = '{"role":"anon"}'
anon = "\${jwt:secret:anon_payload}"
[config]
env = ["JWT=\${anon}", "S=\${secret}"]
`,
			"app",
			{ serverIp: "", projectName: "app" },
		);
		const jwt = result.envs[0].slice(4);
		const [, payload] = jwt.split(".");
		const decoded = JSON.parse(
			atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
		);
		expect(decoded).toMatchObject({ role: "anon", iss: "panara-cloud" });
		expect(jwt.split(".")).toHaveLength(3);
	});
});

describe("template catalog", () => {
	test("refresh fills the catalog, search and tags work, and stale entries are pruned", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "member");
		routes[`${CATALOG}/meta.json`] = () =>
			Response.json(meta(["plausible", "postgres"]));
		await t.action(internal.platform.templatesSync.refreshCatalog, {});
		const alice = asUser(t, "alice");
		const all = await alice.query(api.platform.templates.list, {});
		expect(all.map((x) => x.templateId).sort()).toEqual([
			"plausible",
			"postgres",
		]);
		expect(all[0]).not.toHaveProperty("searchText");
		expect(all.find((x) => x.templateId === "plausible")?.logoUrl).toBe(
			`${CATALOG}/blueprints/plausible/plausible.svg`,
		);
		expect(
			(
				await alice.query(api.platform.templates.list, { search: "analytics" })
			).map((x) => x.templateId),
		).toEqual(["plausible"]);
		expect(
			(await alice.query(api.platform.templates.list, { tag: "database" })).map(
				(x) => x.templateId,
			),
		).toEqual(["postgres"]);
		expect(await alice.query(api.platform.templates.tags, {})).toEqual([
			"analytics",
			"database",
		]);
		await expect(t.query(api.platform.templates.list, {})).rejects.toThrow(
			/Not authenticated/,
		);

		routes[`${CATALOG}/meta.json`] = () => Response.json(meta(["plausible"]));
		await t.action(internal.platform.templatesSync.refreshCatalog, {});
		expect(
			(await alice.query(api.platform.templates.list, {})).map(
				(x) => x.templateId,
			),
		).toEqual(["plausible"]);

		routes[`${CATALOG}/meta.json`] = () => Response.json([]);
		await t.action(internal.platform.templatesSync.refreshCatalog, {});
		expect(await alice.query(api.platform.templates.list, {})).toHaveLength(1);
	});

	test("the base URL is configurable", async () => {
		process.env.TEMPLATES_BASE_URL = "https://templates.example.com/";
		const t = setup();
		routes["https://templates.example.com/meta.json"] = () =>
			Response.json(meta(["plausible"]));
		expect(
			await t.action(internal.platform.templatesSync.refreshCatalog, {}),
		).toEqual({ count: 1 });
	});

	test("without configuration Panara Cloud's own catalog is used", async () => {
		delete process.env.TEMPLATES_BASE_URL;
		const t = setup();
		routes["https://panarastudios.github.io/panara-cloud-templates/meta.json"] =
			() => Response.json(meta(["plausible"]));
		expect(
			await t.action(internal.platform.templatesSync.refreshCatalog, {}),
		).toEqual({ count: 1 });
	});

	test("entries from a catalog that is no longer configured are replaced", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "member");
		routes[`${CATALOG}/meta.json`] = () =>
			Response.json(meta(["plausible", "postgres"]));
		await t.action(internal.platform.templatesSync.refreshCatalog, {});
		const alice = asUser(t, "alice");
		expect(await alice.query(api.platform.templates.list, {})).toHaveLength(2);

		delete process.env.TEMPLATES_BASE_URL;
		routes["https://panarastudios.github.io/panara-cloud-templates/meta.json"] =
			() => Response.json(meta(["plausible"]));
		await t.action(internal.platform.templatesSync.refreshCatalog, {});
		const listed = await alice.query(api.platform.templates.list, {});
		expect(listed.map((template) => template.templateId)).toEqual([
			"plausible",
		]);
	});

	test("bookmarks are per user and organization", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "member");
		await addMember(t, "org1", "bob", "member");
		const alice = asUser(t, "alice");
		await alice.mutation(api.platform.templates.setBookmark, {
			organizationId: "org1",
			templateId: "plausible",
			bookmarked: true,
		});
		await alice.mutation(api.platform.templates.setBookmark, {
			organizationId: "org1",
			templateId: "plausible",
			bookmarked: true,
		});
		expect(
			await alice.query(api.platform.templates.listBookmarks, {
				organizationId: "org1",
			}),
		).toEqual(["plausible"]);
		expect(
			await asUser(t, "bob").query(api.platform.templates.listBookmarks, {
				organizationId: "org1",
			}),
		).toEqual([]);
		await expect(
			asUser(t, "mallory").mutation(api.platform.templates.setBookmark, {
				organizationId: "org1",
				templateId: "plausible",
				bookmarked: true,
			}),
		).rejects.toThrow(/Not a member/);
		await alice.mutation(api.platform.templates.setBookmark, {
			organizationId: "org1",
			templateId: "plausible",
			bookmarked: false,
		});
		expect(
			await alice.query(api.platform.templates.listBookmarks, {
				organizationId: "org1",
			}),
		).toEqual([]);
	});

	test("prepares a catalog template for compose and falls back to the cache", async () => {
		const t = setup();
		await t.run((ctx) =>
			ctx.db.insert("servers", {
				organizationId: "org1",
				name: "web",
				ipAddress: "198.51.100.4",
				port: 22,
				username: "root",
				serverType: "deploy",
				buildsConcurrency: 1,
				enableDockerCleanup: false,
			}),
		);
		const serverId = (await t.run((ctx) => ctx.db.query("servers").first()))
			?._id;
		const base = `${CATALOG}/blueprints/plausible`;
		routes[`${base}/template.toml`] = () => new Response(PLAUSIBLE_TOML);
		routes[`${base}/docker-compose.yml`] = () =>
			new Response("services:\n  plausible:\n    image: plausible\n");
		const prepared = await t.action(
			internal.platform.templatesSync.prepareCatalogTemplate,
			{
				organizationId: "org1",
				templateId: "plausible",
				projectName: "My Shop",
				serverId,
			},
		);
		expect(prepared.appName).toMatch(/^my-shop-plausible-[a-z0-9]{6}$/);
		expect(prepared.composeFile).toContain("image: plausible");
		expect(prepared.domains[0].host).toContain("198-51-100-4.sslip.io");
		expect(prepared.envs).toContain(`APP=${prepared.appName}`);

		routes = {};
		const cached = await t.action(
			internal.platform.templatesSync.prepareCatalogTemplate,
			{ organizationId: "org1", templateId: "plausible", projectName: "x" },
		);
		expect(cached.composeFile).toContain("image: plausible");
		await expect(
			t.action(internal.platform.templatesSync.prepareCatalogTemplate, {
				organizationId: "org1",
				templateId: "unknown",
				projectName: "x",
			}),
		).rejects.toThrow(/not found or could not be fetched/);
		await expect(
			t.action(internal.platform.templatesSync.prepareCatalogTemplate, {
				organizationId: "org2",
				templateId: "plausible",
				projectName: "x",
				serverId,
			}),
		).rejects.toThrow(/Server not found/);
	});

	test("previews a custom base64 template for members only", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "member");
		const base64 = btoa(
			JSON.stringify({ compose: "services: {}", config: PLAUSIBLE_TOML }),
		);
		const preview = await asUser(t, "alice").action(
			api.platform.templatesSync.preview,
			{ organizationId: "org1", appName: "custom", base64 },
		);
		expect(preview.envs).toContain("APP=custom");
		expect(preview.domains[0].host).toContain("127-0-0-1.sslip.io");
		await expect(
			asUser(t, "mallory").action(api.platform.templatesSync.preview, {
				organizationId: "org1",
				appName: "custom",
				base64,
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			asUser(t, "alice").action(api.platform.templatesSync.preview, {
				organizationId: "org1",
				appName: "custom",
				base64: btoa("{}"),
			}),
		).rejects.toThrow(/Must contain compose and config/);
		expect(fetched).toEqual([]);
	});
});
