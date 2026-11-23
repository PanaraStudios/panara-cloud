import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { serverWorkState } from "./lib/serverState";
import {
	addMember,
	addServer,
	asApiKey,
	asUser,
	grantMember,
	setup,
} from "./test.setup";

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	const alice = asUser(t, "alice");
	const sshKeyId = await alice.action(api.sshKeys.create, {
		organizationId: "org1",
		name: "deploy key",
		publicKey: "ssh-ed25519 AAAAC3Nza panel",
		privateKey:
			"-----BEGIN OPENSSH PRIVATE KEY-----\nmaterial\n-----END OPENSSH PRIVATE KEY-----",
	});
	const serverId = await alice.mutation(api.servers.create, {
		organizationId: "org1",
		name: "web-1",
		ipAddress: "10.0.0.5",
		port: 22,
		username: "root",
		sshKeyId,
		serverType: "deploy",
		enableDockerCleanup: true,
	});
	const { environmentId } = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "Shop",
	});
	return { t, alice, serverId, environmentId };
};

describe("servers", () => {
	test("get includes the attached key's public half, never the private key", async () => {
		const { t, alice, serverId } = await seed();
		const server = await alice.query(api.servers.get, { serverId });
		expect(server?.sshKey).toEqual({
			name: "deploy key",
			publicKey: "ssh-ed25519 AAAAC3Nza panel",
		});
		expect(JSON.stringify(server)).not.toContain("PRIVATE KEY");
		await expect(
			asUser(t, "eve").query(api.servers.get, { serverId }),
		).rejects.toThrow();
	});

	test("services lists what runs or builds on the server, for its organization only", async () => {
		const { t, alice, serverId, environmentId } = await seed();
		expect(await alice.query(api.servers.services, { serverId })).toEqual([]);
		const appId = await alice.mutation(api.applications.applications.create, {
			environmentId,
			name: "Web",
			serverId,
		});
		const composeId = await alice.mutation(api.compose.crud.create, {
			environmentId,
			name: "Stack",
			serverId,
		});
		await expect(
			asUser(t, "mallory").query(api.servers.services, { serverId }),
		).rejects.toThrow(/access to this server/);
		const services = await alice.query(api.servers.services, { serverId });
		expect(services).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "application",
					id: appId,
					name: "Web",
				}),
				expect.objectContaining({
					type: "compose",
					id: composeId,
					name: "Stack",
					environmentId,
				}),
			]),
		);
		expect(services).toHaveLength(2);
		await expect(
			asUser(t, "eve").query(api.servers.services, { serverId }),
		).rejects.toThrow();
		await expect(
			alice.mutation(api.servers.remove, { serverId }),
		).rejects.toThrow(/still runs/);
	});

	test("a member without server.read is given no server", async () => {
		const { t, alice, serverId, environmentId } = await seed();
		const mallory = asUser(t, "mallory");
		expect(
			await alice.query(api.servers.list, { organizationId: "org1" }),
		).toHaveLength(1);
		expect(
			await mallory.query(api.servers.list, { organizationId: "org1" }),
		).toEqual([]);
		await expect(mallory.query(api.servers.get, { serverId })).rejects.toThrow(
			/access to this server/,
		);
		await expect(
			mallory.query(api.servers.getSetupScript, { serverId }),
		).rejects.toThrow(/access to this server/);
		const tree = await mallory.query(api.projects.navigationTree, {
			organizationId: "org1",
		});
		expect(tree.servers).toBeNull();
		expect(
			(
				await alice.query(api.projects.navigationTree, {
					organizationId: "org1",
				})
			).servers,
		).toHaveLength(1);
		expect(
			await mallory.query(api.servers.listNames, { organizationId: "org1" }),
		).toEqual([]);
		await expect(
			asUser(t, "eve").query(api.servers.listNames, { organizationId: "org1" }),
		).rejects.toThrow(/Not a member/);
		await expect(
			asApiKey(t, "alice", "org2").query(api.servers.listNames, {
				organizationId: "org1",
			}),
		).rejects.toThrow(/another organization/);

		// Granted services do not open the server itself.
		const appId = await alice.mutation(api.applications.applications.create, {
			environmentId,
			name: "Web",
			serverId,
		});
		await grantMember(t, "org1", "mallory", { services: [appId] });
		expect(
			await mallory.query(api.servers.list, { organizationId: "org1" }),
		).toEqual([]);
		await expect(mallory.query(api.servers.get, { serverId })).rejects.toThrow(
			/access to this server/,
		);
	});

	test("listNames gives a member the servers of their services, and all of them with service.create", async () => {
		const { t, alice, serverId, environmentId } = await seed();
		const otherId = await addServer(t, "org1", "10.0.0.9");
		const buildId = await addServer(t, "org1", "10.0.0.10");
		await addServer(t, "org2", "10.0.0.11");
		const mallory = asUser(t, "mallory");
		const names = () =>
			mallory.query(api.servers.listNames, { organizationId: "org1" });
		const appId = await alice.mutation(api.applications.applications.create, {
			environmentId,
			name: "Web",
			serverId,
		});
		await t.run((ctx) =>
			ctx.db.patch("applications", appId, { buildServerId: buildId }),
		);
		await alice.mutation(api.compose.crud.create, {
			environmentId,
			name: "Stack",
			serverId: otherId,
		});
		expect(await names()).toEqual([]);

		await grantMember(t, "org1", "mallory", { services: [appId] });
		const own = await names();
		expect(own.map((server) => server._id).sort()).toEqual(
			[serverId, buildId].sort(),
		);
		// Never the address, the SSH user or the check results.
		expect(own.find((server) => server._id === serverId)).toEqual({
			_id: serverId,
			name: "web-1",
			serverType: "deploy",
			state: "ready",
			ipAddress: null,
		});

		await grantMember(t, "org1", "mallory", {
			flags: { canCreateServices: true },
		});
		const all = await names();
		expect(all.map((server) => server._id).sort()).toEqual(
			[serverId, otherId, buildId].sort(),
		);
		expect(all.every((server) => server.ipAddress === null)).toBe(true);
		const forOwner = await alice.query(api.servers.listNames, {
			organizationId: "org1",
		});
		expect(forOwner.map((server) => server.ipAddress).sort()).toEqual([
			"10.0.0.10",
			"10.0.0.5",
			"10.0.0.9",
		]);
	});

	test("a server's state comes from its switch, its key and its last check", () => {
		expect(serverWorkState({ serverStatus: "inactive", sshKeyId: "k" })).toBe(
			"inactive",
		);
		expect(serverWorkState({ serverStatus: "active" })).toBe("notSetUp");
		expect(serverWorkState({ serverStatus: "inactive" })).toBe("notSetUp");
		expect(serverWorkState({ sshKeyId: "k" })).toBe("ready");
		expect(
			serverWorkState({
				sshKeyId: "k",
				lastValidation: { ok: false, details: "connect ECONNREFUSED" },
			}),
		).toBe("offline");
		expect(
			serverWorkState({
				sshKeyId: "k",
				lastValidation: { ok: false, details: "rclone: unavailable" },
			}),
		).toBe("ready");
	});
});
