import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import {
	addMember,
	addServer,
	asUser,
	grantMember,
	setup,
} from "../test.setup";
import { assertHostsFree } from "./routing";

const domain = (host: string, path?: string) => ({
	host,
	path,
	https: false,
	certificateType: "none" as const,
	port: 3000,
});

// org1 (oldest membership) is the root organization; alice its admin.
const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "admin");
	await addMember(t, "org2", "eve", "owner");
	const alice = asUser(t, "alice");
	const eve = asUser(t, "eve");
	const root = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "Root",
	});
	const other = await eve.mutation(api.projects.create, {
		organizationId: "org2",
		name: "Other",
	});
	const serverId = await addServer(t, "org2");
	const app = async (
		who: typeof eve,
		environmentId: typeof other.environmentId,
		name: string,
		server?: typeof serverId,
	) => ({
		kind: "application" as const,
		id: await who.mutation(api.applications.applications.create, {
			environmentId,
			name,
			serverId: server,
		}),
	});
	return { t, alice, eve, root, other, serverId, app };
};

describe("domain hosts", () => {
	test("Panara Cloud's own hosts are reserved", async () => {
		const { t, alice, eve, root, other, serverId, app } = await seed();
		await t.run((ctx) =>
			ctx.db.insert("webServerSettings", {
				key: "instance",
				host: "panel.example.com",
				https: true,
				certificateType: "letsencrypt",
				enableDockerCleanup: false,
				cleanupCacheApplications: false,
				cleanupCacheOnPreviews: false,
				cleanupCacheOnCompose: false,
			}),
		);
		const theirs = await app(eve, other.environmentId, "web", serverId);
		for (const host of ["panel.example.com", "site.test"]) {
			await expect(
				eve.mutation(api.infra.domains.create, {
					owner: theirs,
					...domain(host, "/api"),
				}),
			).rejects.toThrow(/reserved for Panara Cloud/);
		}
		const mine = await app(alice, root.environmentId, "web");
		await expect(
			alice.mutation(api.infra.domains.create, {
				owner: mine,
				...domain("panel.example.com", "/x"),
			}),
		).rejects.toThrow(/reserved for Panara Cloud/);
		await alice.mutation(api.infra.domains.create, {
			owner: mine,
			...domain("shop.example.com"),
		});
	});

	test("a host is only shared across paths by services the caller manages", async () => {
		const { t, eve, other, serverId, app } = await seed();
		const first = await app(eve, other.environmentId, "a", serverId);
		const second = await app(eve, other.environmentId, "b", serverId);
		await eve.mutation(api.infra.domains.create, {
			owner: first,
			...domain("shop.example.com"),
		});
		await eve.mutation(api.infra.domains.create, {
			owner: first,
			...domain("shop.example.com", "/api"),
		});
		await addMember(t, "org2", "bob", "member");
		await grantMember(t, "org2", "bob", {
			services: [second.id],
			flags: { canCreateServices: true },
		});
		const bob = asUser(t, "bob");
		await expect(
			bob.mutation(api.infra.domains.create, {
				owner: second,
				...domain("shop.example.com", "/admin"),
			}),
		).rejects.toThrow(/already used by another service/);
		const id = await bob.mutation(api.infra.domains.create, {
			owner: second,
			...domain("other.example.com"),
		});
		await expect(
			bob.mutation(api.infra.domains.update, {
				domainId: id,
				...domain("shop.example.com", "/admin"),
			}),
		).rejects.toThrow(/already used by another service/);
		await eve.mutation(api.infra.domains.create, {
			owner: second,
			...domain("shop.example.com", "/admin"),
		});
	});

	test("another organization can't take a path under a host on a shared server", async () => {
		const t = setup();
		const legacy = { kind: "application" as const, id: "legacy" };
		const intruder = { kind: "application" as const, id: "intruder" };
		await t.run(async (ctx) => {
			await ctx.db.insert("routingOwners", {
				organizationId: "org1",
				owner: legacy,
				appName: "legacy",
			});
			await ctx.db.insert("routingOwners", {
				organizationId: "org2",
				owner: intruder,
				appName: "intruder",
			});
			await ctx.db.insert("domains", {
				organizationId: "org1",
				owner: legacy,
				host: "shop.example.com",
				path: "/",
				https: false,
				certificateType: "none",
				port: 80,
				internalPath: "/",
				stripPath: false,
				middlewares: [],
				enabled: true,
			});
		});
		await expect(
			t.run((ctx) =>
				assertHostsFree(ctx, undefined, [
					{ owner: intruder, host: "shop.example.com", path: "/api" },
				]),
			),
		).rejects.toThrow(/already used by another service/);
		await t.run((ctx) =>
			assertHostsFree(ctx, undefined, [
				{ owner: legacy, host: "shop.example.com", path: "/api" },
			]),
		);
	});
});
