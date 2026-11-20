import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	grantMember,
	setup,
	type TestConvex,
} from "../test.setup";
import { checkResolution, detectCdn } from "./domains";
import { registerRoutingOwner } from "./routing";

afterEach(() => {
	vi.unstubAllGlobals();
});

const addServer = (t: TestConvex, organizationId = "org1") =>
	t.run((ctx) =>
		ctx.db.insert("servers", {
			organizationId,
			name: "web",
			ipAddress: "203.0.113.7",
			port: 22,
			username: "root",
			serverType: "deploy",
			buildsConcurrency: 1,
			enableDockerCleanup: true,
		}),
	);

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "eve", "owner");
	const alice = asUser(t, "alice");
	const serverId = await addServer(t);
	const { environmentId } = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "Shop",
	});
	const composeId = await alice.mutation(api.compose.crud.create, {
		environmentId,
		name: "stack",
		serverId,
		composeFile: "services:\n  web:\n    image: nginx\n",
	});
	const agent = asAgent(t, await addAgent(t));
	return { t, alice, serverId, composeId, agent };
};

const claim = async (
	s: Awaited<ReturnType<typeof seed>>,
	jobId: Id<"jobs">,
) => {
	const claimed = await s.agent.mutation(api.agent.claimNext, {});
	expect(claimed?.jobId).toBe(jobId);
	return { jobId, leaseId: claimed?.leaseId ?? "" };
};

describe("file mount drift check", () => {
	test("reads a compose file mount on the compose's server", async () => {
		const s = await seed();
		const mountId = await s.alice.mutation(api.compose.mounts.add, {
			composeId: s.composeId,
			mount: {
				type: "file",
				filePath: "conf/nginx.conf",
				content: "a",
				mountPath: "",
			},
		});
		await expect(
			asUser(s.t, "eve").mutation(api.infra.mounts.readFileOnHost, {
				mountId,
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			asUser(s.t, "bob").mutation(api.infra.mounts.readFileOnHost, {
				mountId,
			}),
		).rejects.toThrow(/access to this service/);
		await grantMember(s.t, "org1", "bob", { services: [s.composeId] });

		const jobId = await asUser(s.t, "bob").mutation(
			api.infra.mounts.readFileOnHost,
			{ mountId },
		);
		const job = await s.t.run((ctx) => ctx.db.get("jobs", jobId));
		expect(job).toMatchObject({
			partition: s.serverId,
			spec: { kind: "infra.readMountFile", mountId },
		});
		const lease = await claim(s, jobId);
		await expect(
			s.alice.query(api.infra.mounts.getMountFileContext, lease),
		).rejects.toThrow();
		const context = await s.agent.query(
			api.infra.mounts.getMountFileContext,
			lease,
		);
		const compose = await s.alice.query(api.compose.crud.get, {
			composeId: s.composeId,
		});
		expect(context).toEqual({
			base: "compose",
			appName: compose?.appName,
			filePath: "conf/nginx.conf",
		});

		await s.agent.mutation(api.infra.agent.reportOpResult, {
			...lease,
			result: JSON.stringify({ found: true, content: "b" }),
		});
		expect(
			await asUser(s.t, "bob").query(api.infra.snapshots.opResult, { jobId }),
		).toMatchObject({ result: JSON.stringify({ found: true, content: "b" }) });
	});

	test("only file mounts have content on the host", async () => {
		const s = await seed();
		const mountId = await s.alice.mutation(api.compose.mounts.add, {
			composeId: s.composeId,
			mount: { type: "volume", volumeName: "data", mountPath: "/data" },
		});
		await expect(
			s.alice.mutation(api.infra.mounts.readFileOnHost, { mountId }),
		).rejects.toThrow(/Only file mounts/);
	});
});

describe("domain DNS validation", () => {
	test("Bunny CDN edges count as a CDN", () => {
		expect(detectCdn("89.187.188.227")?.name).toBe("Bunny CDN");
		expect(checkResolution(["89.187.188.227"], ["203.0.113.7"])).toMatchObject({
			isValid: true,
			cdnProvider: "Bunny CDN",
		});
	});

	test("any of the server's addresses validates", () => {
		expect(
			checkResolution(["198.51.100.9"], ["203.0.113.7", "198.51.100.9"]),
		).toEqual({ isValid: true, resolvedIp: "198.51.100.9", error: undefined });
		expect(
			checkResolution(["192.0.2.1"], ["203.0.113.7", "198.51.100.9"]).error,
		).toBe(
			"Domain resolves to 192.0.2.1 but should point to 203.0.113.7 or 198.51.100.9",
		);
	});

	test("probed addresses of the same server extend the expected ones", async () => {
		const s = await seed();
		const owner = { kind: "compose" as const, id: s.composeId };
		await expect(
			asUser(s.t, "eve").mutation(api.infra.domains.probeAddresses, { owner }),
		).rejects.toThrow(/Not a member/);
		await grantMember(s.t, "org1", "bob", { services: [s.composeId] });
		const jobId = await asUser(s.t, "bob").mutation(
			api.infra.domains.probeAddresses,
			{ owner },
		);
		const lease = await claim(s, jobId);
		await s.agent.mutation(api.infra.agent.reportOpResult, {
			...lease,
			result: JSON.stringify({
				addresses: ["10.0.0.5", "198.51.100.9", "not-an-ip"],
			}),
		});
		expect(
			await s.alice.query(api.infra.domains.expectedAddresses, {
				owner,
				probeJobId: jobId,
			}),
		).toEqual(["203.0.113.7", "10.0.0.5", "198.51.100.9"]);

		// A probe of another host does not count.
		const other = await s.t.run(async (ctx) => {
			const serverId = await ctx.db.insert("servers", {
				organizationId: "org1",
				name: "other",
				ipAddress: "192.0.2.50",
				port: 22,
				username: "root",
				serverType: "deploy",
				buildsConcurrency: 1,
				enableDockerCleanup: true,
			});
			await registerRoutingOwner(ctx, {
				organizationId: "org1",
				owner: { kind: "application", id: "app2" },
				serverId,
				appName: "app-two",
			});
			return { kind: "application" as const, id: "app2" };
		});
		expect(
			await s.alice.query(api.infra.domains.expectedAddresses, {
				owner: other,
				probeJobId: jobId,
			}),
		).toEqual(["192.0.2.50"]);

		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				const type = new URL(url).searchParams.get("type");
				return new Response(
					JSON.stringify({
						Answer: type === "A" ? [{ type: 1, data: "198.51.100.9" }] : [],
					}),
				);
			}),
		);
		expect(
			await s.alice.action(api.infra.domains.validateHost, {
				owner,
				host: "shop.example.com",
				probeJobId: jobId,
			}),
		).toMatchObject({ isValid: true, resolvedIp: "198.51.100.9" });
		expect(
			await s.alice.action(api.infra.domains.validateHost, {
				owner,
				host: "shop.example.com",
			}),
		).toMatchObject({ isValid: false });
	});

	test("toggling a compose domain reports that a redeploy is needed", async () => {
		const s = await seed();
		const domainId = await s.alice.mutation(api.infra.domains.create, {
			owner: { kind: "compose", id: s.composeId },
			host: "shop.example.com",
			port: 80,
			https: false,
			certificateType: "none",
			serviceName: "web",
		});
		expect(
			await s.alice.mutation(api.infra.domains.setEnabled, {
				domainId,
				enabled: false,
			}),
		).toEqual({ enabled: false, requiresRedeploy: true });
	});
});
