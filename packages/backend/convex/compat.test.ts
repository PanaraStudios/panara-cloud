/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import previousSchema from "../compat/v0.1.6/schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	grantMember,
	setup,
	type TestConvex,
} from "./test.setup";

// Rolling back to the previous release keeps the database, and Convex
// checks every stored document against that release's schema: one it
// rejects fails the rollback ("Schema validation failed"), and the jobs
// table keeps the newest job of each kind for good. What this release
// stores must stay in a shape the previous release accepts.

const previous = () =>
	convexTest(previousSchema, import.meta.glob("./_generated/*.{js,ts}"));

type Stored = { table: string; doc: Record<string, unknown> };

// Every document of every table, without the system fields.
const storedDocuments = async (t: TestConvex): Promise<Stored[]> =>
	await t.run(async (ctx) => {
		const out: Stored[] = [];
		for (const table of Object.keys(schema.tables)) {
			const docs = await ctx.db
				.query(table as keyof typeof schema.tables)
				.collect();
			for (const doc of docs) {
				const { _id, _creationTime, ...rest } = doc as Record<string, unknown>;
				out.push({ table, doc: rest });
			}
		}
		return out;
	});

const rejectedByPrevious = async (stored: Stored[]) => {
	const old = previous();
	const rejected: string[] = [];
	for (const { table, doc } of stored) {
		try {
			await old.run((ctx) => ctx.db.insert(table as never, doc as never));
		} catch (error) {
			rejected.push(
				`${table} ${JSON.stringify(doc).slice(0, 200)}: ${String(error).split("\n")[0]}`,
			);
		}
	}
	return rejected;
};

const COMPOSE = "services:\n  web:\n    image: nginx:alpine\n";

// The compose jobs an instance administrator and a member queue, and the
// rows they leave, through the same mutations the panel calls.
const composeScenario = async () => {
	const t = setup();
	await addMember(t, "org1", "admin", "admin");
	await addMember(t, "org1", "bob", "member");
	const admin = asUser(t, "admin");
	const { environmentId } = await admin.mutation(api.projects.create, {
		organizationId: "org1",
		name: "Shop",
	});
	const createCompose = (name: string) =>
		admin.mutation(api.compose.crud.create, {
			environmentId,
			name,
			composeFile: COMPOSE,
		});
	const composeId = await createCompose("Stack");
	await grantMember(t, "org1", "bob", { services: [composeId] });
	await admin.mutation(api.compose.deploy.deploy, { composeId });
	const agent = asAgent(t, await addAgent(t));
	await agent.mutation(api.agent.hello, {
		version: "0.1.7",
		capabilities: ["compose.deploy", "compose.snapshots"],
	});
	// The agent picks the deploy up and finishes it.
	const claim = await agent.mutation(api.agent.claimNext, {});
	await agent.query(api.compose.agent.getContext, {
		jobId: claim?.jobId as Id<"jobs">,
		leaseId: claim?.leaseId as string,
	});
	await t.run((ctx) => ctx.db.patch("compose", composeId, { status: "done" }));
	await admin.mutation(api.compose.deploy.start, { composeId });
	await asUser(t, "bob").mutation(api.compose.deploy.start, { composeId });
	await admin.mutation(api.compose.deploy.stop, { composeId });
	await admin.mutation(api.compose.deploy.redeploy, { composeId });
	const git = await admin.mutation(api.compose.crud.create, {
		environmentId,
		name: "Git",
		composeFile: COMPOSE,
	});
	await admin.mutation(api.compose.crud.remove, {
		composeId: git,
		deleteVolumes: false,
	});
	await admin.mutation(api.compose.crud.remove, {
		composeId,
		deleteVolumes: true,
	});
	return t;
};

describe("what this release stores, 0.1.6 still accepts", () => {
	test("compose jobs and rows: deploy, start (admin and member), stop, redeploy, removals", async () => {
		const t = await composeScenario();
		const stored = await storedDocuments(t);
		const kinds = stored
			.filter(({ table }) => table === "jobs")
			.map(({ doc }) => (doc.spec as { kind: string }).kind);
		expect(new Set(kinds)).toEqual(
			new Set([
				"compose.deploy",
				"compose.start",
				"compose.stop",
				"compose.redeploy",
				"compose.remove",
			]),
		);
		expect(await rejectedByPrevious(stored)).toEqual([]);
	});

	test("the check bites: fields 0.1.6 does not know are rejected", async () => {
		const t = await composeScenario();
		const stored = await storedDocuments(t);
		const start = stored.find(
			({ table, doc }) =>
				table === "jobs" &&
				(doc.spec as { kind: string }).kind === "compose.start",
		);
		const remove = stored.find(
			({ table, doc }) =>
				table === "jobs" &&
				(doc.spec as { kind: string }).kind === "compose.remove",
		);
		expect(start && remove).toBeTruthy();
		const rejected = await rejectedByPrevious([
			{
				table: "jobs",
				doc: {
					...start?.doc,
					spec: { ...(start?.doc.spec as object), trusted: true },
				},
			},
			{
				table: "jobs",
				doc: {
					...remove?.doc,
					spec: { ...(remove?.doc.spec as object), sourceType: "git" },
				},
			},
		]);
		expect(rejected).toHaveLength(2);
	});

	test("every table this release defines exists in 0.1.6", () => {
		expect(
			Object.keys(schema.tables).filter(
				(table) => !(table in previousSchema.tables),
			),
		).toEqual([]);
	});
});
