import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addAgent, addMember, asAgent, asUser, setup } from "../test.setup";

const COMPOSE_FILE = "services:\n  web:\n    image: nginx:alpine\n";

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "mallory", "owner");
	const alice = asUser(t, "alice");
	const { environmentId } = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "Shop",
	});
	const composeId = await alice.mutation(api.compose.crud.create, {
		environmentId,
		name: "Web stack",
		composeFile: COMPOSE_FILE,
	});
	const agent = asAgent(t, await addAgent(t));
	return { t, alice, composeId, agent };
};

type Agent = ReturnType<typeof asAgent>;

const claim = async (agent: Agent, kind: string) => {
	for (let i = 0; i < 20; i++) {
		const next = await agent.mutation(api.agent.claimNext, {});
		if (!next) break;
		const lease = { jobId: next.jobId, leaseId: next.leaseId };
		if (next.spec.kind === kind) return lease;
		await agent.mutation(api.agent.complete, {
			...lease,
			result: { kind: "none" },
		});
	}
	throw new Error(`No ${kind} job queued`);
};

const useGitSource = (
	alice: ReturnType<typeof asUser>,
	composeId: Id<"compose">,
) =>
	alice.mutation(api.compose.crud.setSource, {
		composeId,
		source: {
			type: "git",
			gitSource: {
				type: "git",
				url: "https://github.com/acme/web.git",
				branch: "main",
				buildPath: "/",
				submodules: false,
			},
		},
	});

describe("compose host ops", () => {
	test("loadMounts reports a service's volumes into its op", async () => {
		const { t, alice, composeId, agent } = await seed();
		await expect(
			asUser(t, "bob").mutation(api.compose.hostOps.loadMounts, {
				composeId,
				serviceName: "web",
			}),
		).rejects.toThrow(/service\.create/);
		await expect(
			asUser(t, "mallory").mutation(api.compose.hostOps.loadMounts, {
				composeId,
				serviceName: "web",
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			alice.mutation(api.compose.hostOps.loadMounts, {
				composeId,
				serviceName: "web; rm -rf /",
			}),
		).rejects.toThrow(/Invalid service name/);
		const { opId } = await alice.mutation(api.compose.hostOps.loadMounts, {
			composeId,
			serviceName: "web",
		});
		const lease = await claim(agent, "compose.loadMounts");
		await expect(
			agent.query(api.compose.agent.getOpContext, {
				...lease,
				leaseId: "stale",
			}),
		).rejects.toThrow(/Lease lost/);
		const context = await agent.query(api.compose.agent.getOpContext, lease);
		expect(context).toMatchObject({
			composeType: "docker-compose",
			serviceName: "web",
			gitSource: null,
		});
		const mounts = [
			{ Type: "volume", Source: "/var/lib/x", Destination: "/d" },
		];
		await agent.mutation(api.compose.agent.reportOp, {
			...lease,
			result: JSON.stringify(mounts),
		});
		const op = await alice.query(api.compose.deploy.getOp, { opId });
		expect(op).toMatchObject({ kind: "mounts" });
		expect(JSON.parse(op?.result ?? "null")).toEqual(mounts);
		await expect(
			asUser(t, "bob").query(api.compose.deploy.getOp, { opId }),
		).rejects.toThrow(/access to this service/);
	});

	test("patch repo browsing needs a git source and returns the clone target", async () => {
		const { t, alice, composeId, agent } = await seed();
		await expect(
			alice.mutation(api.compose.hostOps.requestPatchTree, { composeId }),
		).rejects.toThrow(/git source/);
		await useGitSource(alice, composeId);
		await expect(
			asUser(t, "bob").mutation(api.compose.hostOps.requestPatchTree, {
				composeId,
			}),
		).rejects.toThrow(/access to this service/);
		await expect(
			alice.mutation(api.compose.hostOps.requestPatchFile, {
				composeId,
				path: "../etc/passwd",
			}),
		).rejects.toThrow(/relative/);
		await alice.mutation(api.compose.hostOps.requestPatchFile, {
			composeId,
			path: "./src/app.ts",
		});
		const lease = await claim(agent, "compose.patchRepo");
		const context = await agent.query(api.compose.agent.getOpContext, lease);
		expect(context).toMatchObject({
			op: "read",
			path: "src/app.ts",
			gitSource: { type: "git", url: "https://github.com/acme/web.git" },
		});
	});

	test("killBuild cancels only the running deploy of that compose", async () => {
		const { t, alice, composeId, agent } = await seed();
		await alice.mutation(api.compose.deploy.deploy, { composeId });
		const lease = await claim(agent, "compose.deploy");
		await expect(
			asUser(t, "bob").mutation(api.compose.deploy.killBuild, { composeId }),
		).rejects.toThrow(/access to this service/);
		await expect(
			asUser(t, "mallory").mutation(api.compose.deploy.killBuild, {
				composeId,
			}),
		).rejects.toThrow(/Not a member/);
		expect(
			await alice.mutation(api.compose.deploy.killBuild, { composeId }),
		).toEqual({ cancelled: 1 });
		// The agent sees the request on its next heartbeat and aborts the job.
		expect(await agent.mutation(api.agent.heartbeat, lease)).toEqual({
			cancelRequested: true,
		});
		await agent.mutation(api.agent.fail, { ...lease, error: "Cancelled" });
		const job = await t.run((ctx) => ctx.db.get("jobs", lease.jobId));
		expect(job?.status).toBe("cancelled");
		expect(
			await alice.mutation(api.compose.deploy.killBuild, { composeId }),
		).toEqual({ cancelled: 0 });
	});
});
