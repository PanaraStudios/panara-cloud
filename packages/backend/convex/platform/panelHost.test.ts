import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { encryptSecret } from "../lib/crypto";
import { addMember, addServer, asUser, setup } from "../test.setup";
import { resolveLinks } from "./lib/transferRows";

const COMPOSE = "services:\n  web:\n    image: nginx:alpine\n";

// org1 holds the oldest membership, so it is the root organization and its
// admin "alice" is the instance administrator.
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
	return { t, alice, eve, root, other };
};

describe("services on the panel host", () => {
	test("compose and templates need the instance administrator", async () => {
		const { t, alice, eve, root, other } = await seed();
		await expect(
			eve.mutation(api.compose.crud.create, {
				environmentId: other.environmentId,
				name: "stack",
				composeFile: COMPOSE,
			}),
		).rejects.toThrow(/Only the instance administrator/);
		await expect(
			eve.mutation(internal.compose.templates.createFromTemplate, {
				environmentId: other.environmentId,
				name: "tpl",
				appName: "tpl",
				composeFile: COMPOSE,
				env: await encryptSecret(""),
				domains: [],
				mounts: [],
			}),
		).rejects.toThrow(/Only the instance administrator/);
		const serverId = await addServer(t, "org2", "10.0.0.2");
		expect(
			await eve.mutation(api.compose.crud.create, {
				environmentId: other.environmentId,
				name: "stack",
				serverId,
				composeFile: COMPOSE,
			}),
		).toBeTruthy();
		expect(
			await alice.mutation(api.compose.crud.create, {
				environmentId: root.environmentId,
				name: "stack",
				composeFile: COMPOSE,
			}),
		).toBeTruthy();
	});

	test("databases need the instance administrator", async () => {
		const { t, alice, eve, root, other } = await seed();
		await expect(
			eve.action(api.databases.databases.create, {
				environmentId: other.environmentId,
				engine: "redis",
				name: "cache",
			}),
		).rejects.toThrow(/Only the instance administrator/);
		const serverId = await addServer(t, "org2", "10.0.0.2");
		expect(
			await eve.action(api.databases.databases.create, {
				environmentId: other.environmentId,
				serverId,
				engine: "redis",
				name: "cache",
			}),
		).toBeTruthy();
		expect(
			await alice.action(api.databases.databases.create, {
				environmentId: root.environmentId,
				engine: "redis",
				name: "cache",
			}),
		).toBeTruthy();
	});

	test("imports and copies never fall back to the panel host", async () => {
		const { t, eve, alice } = await seed();
		const own = await addServer(t, "org2", "10.0.0.2");
		const foreign = await addServer(t, "org1", "10.0.0.1");
		const resolve = (
			who: typeof eve,
			organizationId: string,
			links: { serverId?: string } | undefined,
			serverId?: typeof own,
		) =>
			who.run((ctx) =>
				resolveLinks(
					ctx,
					{ organizationId, links: links as never, serverId, name: "x" },
					[],
				),
			);
		await expect(resolve(eve, "org2", { serverId: foreign })).rejects.toThrow(
			/its server is not available/,
		);
		await expect(resolve(eve, "org2", {})).rejects.toThrow(
			/Only the instance administrator/,
		);
		await expect(resolve(eve, "org2", undefined)).rejects.toThrow(
			/Only the instance administrator/,
		);
		expect(
			await resolve(eve, "org2", { serverId: foreign }, own),
		).toMatchObject({ serverId: own });
		expect(await resolve(eve, "org2", { serverId: own })).toMatchObject({
			serverId: own,
		});
		expect(await resolve(alice, "org1", {})).toMatchObject({});
		await expect(resolve(alice, "org2", {})).rejects.toThrow(/Select a server/);
	});
});
