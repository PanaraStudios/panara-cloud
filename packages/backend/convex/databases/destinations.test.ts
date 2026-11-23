import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	setup,
	type TestConvex,
} from "../test.setup";
import { DESTINATION_DRAFT_KIND, DESTINATION_SECRET_KIND } from "./lib";

const SECRET_KEY = "stored-secret-key";

const destinationArgs = {
	name: "minio",
	provider: "Minio",
	accessKey: "minio-access",
	bucket: "backups",
	region: "us-east-1",
	endpoint: "http://10.0.0.5:9000",
	additionalFlags: [],
};

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "admin");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "eve", "owner");
	const destinationId = await asUser(t, "alice").action(
		api.databases.destinations.create,
		{ organizationId: "org1", ...destinationArgs, secretAccessKey: SECRET_KEY },
	);
	return { t, destinationId };
};

const secretRow = (t: TestConvex, kind: string, ownerId: string) =>
	t.run((ctx) =>
		ctx.db
			.query("secrets")
			.withIndex("by_kind_and_ownerId", (q) =>
				q.eq("kind", kind).eq("ownerId", ownerId),
			)
			.unique(),
	);

const draft = { ...destinationArgs, bucket: "other-bucket", name: "Test" };

describe("destination connection test", () => {
	test("a draft without a secret uses the stored secret of the destination", async () => {
		const { t, destinationId } = await seed();
		const { opId, jobId } = await asUser(t, "alice").action(
			api.databases.destinations.testConnection,
			{ organizationId: "org1", destinationId, draft },
		);

		const stored = await secretRow(t, DESTINATION_SECRET_KIND, destinationId);
		const copied = await secretRow(t, DESTINATION_DRAFT_KIND, opId);
		expect(copied).toMatchObject({
			organizationId: "org1",
			iv: stored?.iv,
			ciphertext: stored?.ciphertext,
		});
		const op = await t.run((ctx) => ctx.db.get("databaseOps", opId));
		expect(op?.request).toEqual({
			kind: "testDestination",
			draft: {
				provider: "Minio",
				accessKey: "minio-access",
				bucket: "other-bucket",
				region: "us-east-1",
				endpoint: "http://10.0.0.5:9000",
				additionalFlags: [],
			},
		});

		const agent = asAgent(t, await addAgent(t));
		const claim = await agent.mutation(api.agent.claimNext, {});
		const context = await agent.query(api.databases.agent.getOpContext, {
			jobId,
			leaseId: claim?.leaseId ?? "",
		});
		expect(context).toMatchObject({
			kind: "testDestination",
			destination: { bucket: "other-bucket", secretAccessKey: SECRET_KEY },
		});
	});

	test("a typed secret wins over the stored one", async () => {
		const { t, destinationId } = await seed();
		const { opId } = await asUser(t, "alice").action(
			api.databases.destinations.testConnection,
			{
				organizationId: "org1",
				destinationId,
				draft: { ...draft, secretAccessKey: "typed-secret" },
			},
		);
		const stored = await secretRow(t, DESTINATION_SECRET_KIND, destinationId);
		const copied = await secretRow(t, DESTINATION_DRAFT_KIND, opId);
		expect(copied?.ciphertext).not.toBe(stored?.ciphertext);
	});

	test("a draft needs a secret when no destination is given", async () => {
		const { t } = await seed();
		await expect(
			asUser(t, "alice").action(api.databases.destinations.testConnection, {
				organizationId: "org1",
				draft,
			}),
		).rejects.toThrow(/Secret key is required/);
		await expect(
			asUser(t, "alice").action(api.databases.destinations.testConnection, {
				organizationId: "org1",
			}),
		).rejects.toThrow(/either a destination or draft/);
	});

	test("other organizations and members can't borrow the stored secret", async () => {
		const { t, destinationId } = await seed();
		await expect(
			asUser(t, "eve").action(api.databases.destinations.testConnection, {
				organizationId: "org2",
				destinationId,
				draft,
			}),
		).rejects.toThrow(/Destination not found/);
		await expect(
			asUser(t, "eve").action(api.databases.destinations.testConnection, {
				organizationId: "org1",
				destinationId,
				draft,
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			asUser(t, "bob").action(api.databases.destinations.testConnection, {
				organizationId: "org1",
				destinationId,
				draft,
			}),
		).rejects.toThrow(/destination.create/);
		const drafts = await t.run(async (ctx) =>
			(await ctx.db.query("secrets").collect()).filter(
				(s) => s.kind === DESTINATION_DRAFT_KIND,
			),
		);
		expect(drafts).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("databaseOps").collect())).toEqual(
			[],
		);
	});

	test("a saved destination is still tested by id", async () => {
		const { t, destinationId } = await seed();
		const { opId } = await asUser(t, "alice").action(
			api.databases.destinations.testConnection,
			{ organizationId: "org1", destinationId },
		);
		const op = await t.run((ctx) => ctx.db.get("databaseOps", opId));
		expect(op?.request).toEqual({ kind: "testDestination", destinationId });
		expect(await secretRow(t, DESTINATION_DRAFT_KIND, opId)).toBeNull();
	});
});
