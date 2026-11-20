import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { GRANT_FLAGS } from "../lib/permissions";
import {
	addMember,
	asUser,
	grantMember,
	setup,
	type TestConvex,
} from "../test.setup";

const openSession = (
	t: TestConvex,
	organizationId: string,
	userId: string,
	status: "pending" | "open" = "open",
) =>
	t.run((ctx) =>
		ctx.db.insert("liveSessions", {
			organizationId,
			userId,
			kind: "hostTerminal",
			partition: "local",
			tokenHash: crypto.randomUUID(),
			status,
			request: { kind: "hostTerminal", organizationId },
			connectBy: Date.now() + 60_000,
			killRequested: false,
		}),
	);

const state = (t: TestConvex, id: Id<"liveSessions">) =>
	t.run(async (ctx) => {
		const row = await ctx.db.get("liveSessions", id);
		return { status: row?.status, killRequested: row?.killRequested };
	});

describe("live sessions end when their authorization does", () => {
	test("grant changes end the member's streams in that organization", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		await addMember(t, "org1", "mallory", "member");
		await grantMember(t, "org1", "mallory", {});
		const open = await openSession(t, "org1", "mallory");
		await asUser(t, "alice").mutation(api.permissions.assign, {
			organizationId: "org1",
			userId: "mallory",
			accessedProjects: [],
			accessedEnvironments: [],
			accessedServices: [],
			...Object.fromEntries(GRANT_FLAGS.map((flag) => [flag, false])),
		} as never);
		expect(await state(t, open)).toMatchObject({ killRequested: true });
	});

	test("deleting an organization ends its streams and empties its Vector agents", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		await addMember(t, "org2", "eve", "owner");
		const open = await openSession(t, "org2", "eve");
		const targetId = await t.run(async (ctx) => {
			const providerId = await ctx.db.insert("telemetryProviders", {
				organizationId: "org2",
				name: "Loki",
				providerType: "loki",
				signals: ["metrics"],
				enabled: true,
			} as never);
			return await ctx.db.insert("vectorTargets", {
				organizationId: "org2",
				providerIds: [providerId],
			});
		});
		await t.mutation(internal.organizationCascade.run, {
			organizationId: "org2",
		});
		expect(await state(t, open)).toMatchObject({ killRequested: true });
		const after = await t.run(async (ctx) => ({
			target: await ctx.db.get("vectorTargets", targetId),
			jobs: await ctx.db.query("jobs").collect(),
		}));
		expect(after.target?.providerIds).toEqual([]);
		expect(after.jobs.map((job) => job.spec)).toContainEqual({
			kind: "platform.vectorReconcile",
			vectorTargetId: targetId,
		});
	});
});
