import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, grantMember, setup } from "../test.setup";

describe("service containers", () => {
	test("members list a service's containers; other organizations can't", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		await addMember(t, "org1", "mallory", "member");
		await addMember(t, "org2", "eve", "owner");
		const alice = asUser(t, "alice");
		const { environmentId } = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Shop",
		});
		const composeId = await alice.mutation(api.compose.crud.create, {
			environmentId,
			name: "Stack",
		});
		const compose = await t.run((ctx) => ctx.db.get("compose", composeId));

		await expect(
			asUser(t, "mallory").mutation(api.infra.docker.listServiceContainers, {
				serviceKind: "compose",
				serviceId: composeId,
			}),
		).rejects.toThrow(/access to this service/);
		await grantMember(t, "org1", "mallory", { services: [composeId] });
		const jobId = await asUser(t, "mallory").mutation(
			api.infra.docker.listServiceContainers,
			{ serviceKind: "compose", serviceId: composeId },
		);
		const job = await t.run((ctx) => ctx.db.get("jobs", jobId));
		expect(job?.spec).toEqual({
			kind: "infra.dockerAction",
			serverId: undefined,
			action: {
				type: "containerList",
				appName: compose?.appName,
				appType: compose?.composeType,
			},
		});
		expect(
			await asUser(t, "mallory").query(api.infra.snapshots.opResult, {
				jobId,
			}),
		).toMatchObject({ status: "queued", result: null });

		await expect(
			asUser(t, "eve").mutation(api.infra.docker.listServiceContainers, {
				serviceKind: "compose",
				serviceId: composeId,
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			alice.mutation(api.infra.docker.listServiceContainers, {
				serviceKind: "application",
				serviceId: composeId,
			}),
		).rejects.toThrow(/Service not found/);
	});

	test("admins can list by app name through docker.run", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		await expect(
			asUser(t, "alice").mutation(api.infra.docker.run, {
				action: { type: "containerList", appName: "bad name;" },
			}),
		).rejects.toThrow(/Invalid app name/);
	});
});
