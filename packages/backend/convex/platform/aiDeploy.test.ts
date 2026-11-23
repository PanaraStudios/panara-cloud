import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, setup } from "../test.setup";

const suggestion = {
	id: "uptime-kuma",
	name: "Uptime Kuma",
	description: "Status monitoring",
	dockerCompose: "services:\n  kuma:\n    image: louislam/uptime-kuma\n",
	envVariables: "PORT=3001",
	domains: [{ host: "kuma.example.com", port: 3001, serviceName: "kuma" }],
	configFiles: [{ filePath: "config/app.conf", content: "a=1" }],
};

describe("ai deploy", () => {
	test("creates a raw compose service with env, domains and file mounts", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org1", "bob", "member");
		const alice = asUser(t, "alice");
		const { environmentId } = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Ops",
		});

		await expect(
			asUser(t, "bob").action(api.platform.aiActions.deploy, {
				environmentId,
				...suggestion,
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);

		const composeId = await alice.action(api.platform.aiActions.deploy, {
			environmentId,
			...suggestion,
		});
		const compose = await alice.query(api.compose.crud.get, { composeId });
		expect(compose).toMatchObject({
			name: "Uptime Kuma",
			description: "Status monitoring",
			sourceType: "raw",
		});
		expect(compose?.appName).toMatch(/^ops-uptime-kuma-[a-z0-9]{6}$/);
		expect(await alice.query(api.compose.crud.getEnv, { composeId })).toBe(
			"PORT=3001",
		);
		expect(
			await alice.query(api.compose.crud.getFile, { composeId }),
		).toContain("uptime-kuma");
		expect(
			await alice.query(api.infra.domains.listByOwner, {
				owner: { kind: "compose", id: composeId },
			}),
		).toMatchObject([{ host: "kuma.example.com", port: 3001 }]);
		expect(
			await alice.query(api.compose.mounts.list, { composeId }),
		).toMatchObject([{ type: "file", filePath: "config/app.conf" }]);
	});
});
