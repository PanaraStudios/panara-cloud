import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, setup } from "../test.setup";

const fields = {
	name: "migrate",
	cronExpression: "0 9 * * *",
	shellType: "bash" as const,
	command: "npm run migrate",
	enabled: false,
};

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "admin");
	await addMember(t, "org2", "eve", "owner");
	const alice = asUser(t, "alice");
	const { environmentId } = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "Shop",
	});
	const composeId = await alice.mutation(api.compose.crud.create, {
		environmentId,
		name: "stack",
		composeFile: "services:\n  web:\n    image: nginx\n",
	});
	return { t, alice, composeId };
};

describe("compose schedules", () => {
	test("editing changes the service the command runs in", async () => {
		const { t, alice, composeId } = await seed();
		const scheduleId = await alice.mutation(api.platform.schedules.create, {
			organizationId: "org1",
			target: { kind: "compose", composeId, serviceName: "web" },
			...fields,
		});
		await alice.mutation(api.platform.schedules.update, {
			scheduleId,
			...fields,
			serviceName: " worker ",
		});
		expect(
			(await alice.query(api.platform.schedules.get, { scheduleId }))?.target,
		).toEqual({ kind: "compose", composeId, serviceName: "worker" });

		await expect(
			alice.mutation(api.platform.schedules.update, {
				scheduleId,
				...fields,
				serviceName: "  ",
			}),
		).rejects.toThrow(/Service name is required/);
		await expect(
			asUser(t, "eve").mutation(api.platform.schedules.update, {
				scheduleId,
				...fields,
				serviceName: "web",
			}),
		).rejects.toThrow(/Not a member/);
	});

	test("only compose schedules take a service name", async () => {
		const { t, alice } = await seed();
		const serverId = await t.run((ctx) =>
			ctx.db.insert("servers", {
				organizationId: "org1",
				name: "web-1",
				ipAddress: "10.0.0.5",
				port: 22,
				username: "root",
				serverType: "deploy",
				buildsConcurrency: 1,
				enableDockerCleanup: false,
			}),
		);
		const scheduleId = await alice.mutation(api.platform.schedules.create, {
			organizationId: "org1",
			target: { kind: "server", serverId },
			...fields,
			command: "",
			script: "echo hi",
		});
		await expect(
			alice.mutation(api.platform.schedules.update, {
				scheduleId,
				...fields,
				command: "",
				serviceName: "web",
			}),
		).rejects.toThrow(/Only compose schedules/);
	});
});
