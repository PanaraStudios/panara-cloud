import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	addAgent,
	addMember,
	addServer,
	asAgent,
	asUser,
	grantMember,
	setup,
} from "../test.setup";
import { composeVolumeNames } from "./volumeRefs";

const NAMING = {
	appName: "shop-abc123",
	randomize: false,
	suffix: "",
	isolatedDeployment: false,
	isolatedDeploymentsVolume: false,
};

describe("the volumes a compose file stands for", () => {
	test("project volumes, explicit names and external ones", () => {
		const names = composeVolumeNames(
			`services:
  db:
    image: postgres
    volumes:
      - data:/var/lib/postgresql/data
      - ./conf:/conf
volumes:
  data:
  cache: {}
  named:
    name: shop-uploads
  borrowed:
    external: true
  renamed:
    external: true
    name: blog_data
  legacy:
    external:
      name: old-style
  templated:
    name: \${VOLUME_NAME}
`,
			NAMING,
		);
		expect(names.created.sort()).toEqual([
			"shop-abc123_cache",
			"shop-abc123_data",
			"shop-uploads",
		]);
		expect(names.referenced.sort()).toEqual([
			"blog_data",
			"borrowed",
			"old-style",
			"shop-abc123_cache",
			"shop-abc123_data",
			"shop-uploads",
		]);
	});

	test("the names a deploy renames are answered in both spellings", () => {
		const file = "volumes:\n  data:\n  ext:\n    external: true\n";
		expect(
			composeVolumeNames(file, { ...NAMING, randomize: true, suffix: "x1" })
				.referenced,
		).toEqual(["shop-abc123_data", "shop-abc123_data-x1", "ext", "ext-x1"]);
		expect(
			composeVolumeNames(file, {
				...NAMING,
				isolatedDeployment: true,
				isolatedDeploymentsVolume: true,
			}).created,
		).toEqual(["shop-abc123_data", "shop-abc123_data-shop-abc123"]);
	});

	test("a file without volumes, or one that does not parse, names none", () => {
		for (const file of ["", "services: {}\n", "volumes: [a, b]\n", ": : :"]) {
			expect(composeVolumeNames(file, NAMING)).toEqual({
				created: [],
				referenced: [],
			});
		}
	});
});

const OWNER_FILE = `services:
  db:
    image: postgres
    volumes: [data:/data, shared:/shared]
volumes:
  data:
  shared:
    name: shared-files
`;
const BORROWER_FILE = `services:
  web:
    image: nginx
    volumes: [files:/files]
volumes:
  files:
    name: shared-files
    external: true
`;

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
	const agent = asAgent(t, await addAgent(t));
	const compose = (
		name: string,
		composeFile: string,
		serverId?: Id<"servers">,
	) =>
		alice.mutation(api.compose.crud.create, {
			environmentId,
			name,
			composeFile,
			serverId,
		});
	const appNameOf = (composeId: Id<"compose">) =>
		t.run(
			async (ctx) => (await ctx.db.get("compose", composeId))?.appName ?? "",
		);
	const claim = async () => {
		const job = await agent.mutation(api.agent.claimNext, {});
		if (!job) throw new Error("expected a job");
		return { jobId: job.jobId, leaseId: job.leaseId };
	};
	return { t, alice, agent, environmentId, compose, appNameOf, claim };
};

describe("who else uses a volume, asked by the removal job", () => {
	test("a compose service that only names the volume keeps it, deployed or not", async () => {
		const s = await seed();
		const shop = await s.compose("Shop", OWNER_FILE);
		await s.compose("Blog", BORROWER_FILE);
		const shopName = await s.appNameOf(shop);

		const jobId = await s.alice.mutation(api.compose.crud.remove, {
			composeId: shop,
			deleteVolumes: true,
		});
		const lease = await s.claim();
		expect(lease.jobId).toBe(jobId);
		const answer = await s.agent.query(api.infra.agent.volumeReferences, {
			...lease,
			volumeNames: ["shared-files", `${shopName}_data`],
		});
		expect(answer.incomplete).toBeNull();
		expect(answer.volumes).toEqual([
			{
				volumeName: "shared-files",
				services: [
					{
						appName: expect.stringMatching(/^blog-/),
						label: "Blog (Compose service)",
					},
				],
			},
		]);
	});

	test("application and database mounts count, on the same server only", async () => {
		const s = await seed();
		const elsewhere = await addServer(s.t, "org1", "10.0.0.7");
		const shop = await s.compose("Shop", OWNER_FILE);
		const shopName = await s.appNameOf(shop);
		const worker = await s.alice.mutation(
			api.applications.applications.create,
			{ environmentId: s.environmentId, name: "Worker" },
		);
		const remote = await s.alice.mutation(
			api.applications.applications.create,
			{ environmentId: s.environmentId, name: "Remote", serverId: elsewhere },
		);
		for (const applicationId of [worker, remote]) {
			await s.alice.mutation(api.applications.mounts.create, {
				applicationId,
				mount: {
					type: "volume",
					volumeName: `${shopName}_data`,
					mountPath: "/data",
				},
			});
		}
		// A bind mount of the same spelling is a host path, not the volume.
		await s.alice.mutation(api.applications.mounts.create, {
			applicationId: worker,
			mount: { type: "bind", hostPath: "/shared-files", mountPath: "/b" },
		});
		const databaseId = await s.alice.action(api.databases.databases.create, {
			environmentId: s.environmentId,
			engine: "postgres",
			name: "Main DB",
			databaseName: "shop",
			databaseUser: "shop",
			databasePassword: "pgpass",
		});
		await s.alice.mutation(api.databases.databases.addDatabaseMount, {
			databaseId,
			mount: { type: "volume", volumeName: "shared-files", mountPath: "/in" },
		});

		await s.alice.mutation(api.compose.crud.remove, {
			composeId: shop,
			deleteVolumes: true,
		});
		const answer = await s.agent.query(api.infra.agent.volumeReferences, {
			...(await s.claim()),
			volumeNames: [`${shopName}_data`, "shared-files", "untouched"],
		});
		expect(answer.volumes).toEqual([
			{
				volumeName: `${shopName}_data`,
				services: [
					{
						appName: expect.any(String),
						label: "Worker (application)",
					},
				],
			},
			{
				volumeName: "shared-files",
				services: [
					{ appName: expect.any(String), label: "Main DB (database)" },
				],
			},
		]);
	});

	test("another organization's service on the same host counts, unnamed", async () => {
		const s = await seed();
		const shop = await s.compose("Shop", OWNER_FILE);
		const mallory = asUser(s.t, "mallory");
		const theirs = await mallory.mutation(api.projects.create, {
			organizationId: "org2",
			name: "Theirs",
		});
		await s.t.run(async (ctx) => {
			const composeId = await ctx.db.insert("compose", {
				...(await ctx.db.get("compose", shop).then((row) => {
					if (!row) throw new Error("missing");
					const { _id, _creationTime, ...fields } = row;
					return fields;
				})),
				organizationId: "org2",
				projectId: theirs.projectId,
				environmentId: theirs.environmentId,
				name: "Secret stack",
				appName: "secret-zzz999",
				refreshToken: "other-token",
			});
			await ctx.db.insert("composeFiles", {
				organizationId: "org2",
				composeId,
				content: BORROWER_FILE,
			});
		});
		await s.alice.mutation(api.compose.crud.remove, {
			composeId: shop,
			deleteVolumes: true,
		});
		const answer = await s.agent.query(api.infra.agent.volumeReferences, {
			...(await s.claim()),
			volumeNames: ["shared-files"],
		});
		expect(answer.volumes).toEqual([
			{
				volumeName: "shared-files",
				services: [{ appName: "secret-zzz999", label: "another service" }],
			},
		]);
	});

	test("deleted together: the other service is named until its own removal, then no longer", async () => {
		const s = await seed();
		const shop = await s.compose("Shop", OWNER_FILE);
		const blog = await s.compose("Blog", BORROWER_FILE);
		const blogName = await s.appNameOf(blog);

		await s.alice.mutation(api.compose.crud.remove, {
			composeId: shop,
			deleteVolumes: true,
			deletingTogether: [blogName],
		});
		const lease = await s.claim();
		const spec = await s.t.run(
			async (ctx) => (await ctx.db.get("jobs", lease.jobId))?.spec,
		);
		expect(spec).toMatchObject({
			kind: "compose.remove",
			deleteVolumes: true,
			deletingTogether: [blogName],
		});
		const ask = () =>
			s.agent.query(api.infra.agent.volumeReferences, {
				...lease,
				volumeNames: ["shared-files"],
			});
		expect((await ask()).volumes[0]?.services).toEqual([
			{ appName: blogName, label: "Blog (Compose service)" },
		]);
		await s.alice.mutation(api.compose.crud.remove, {
			composeId: blog,
			deleteVolumes: true,
		});
		expect((await ask()).volumes).toEqual([]);
	});

	test("only the agent holding the removal job's lease may ask", async () => {
		const s = await seed();
		const shop = await s.compose("Shop", OWNER_FILE);
		const blog = await s.compose("Blog", BORROWER_FILE);
		await s.alice.mutation(api.compose.deploy.deploy, { composeId: blog });
		const deploy = await s.claim();
		await expect(
			s.agent.query(api.infra.agent.volumeReferences, {
				...deploy,
				volumeNames: ["shared-files"],
			}),
		).rejects.toThrow(/Not available for compose.deploy jobs/);

		await s.alice.mutation(api.compose.crud.remove, {
			composeId: shop,
			deleteVolumes: true,
		});
		const lease = await s.claim();
		const args = { ...lease, volumeNames: ["shared-files"] };
		await expect(
			s.alice.query(api.infra.agent.volumeReferences, args),
		).rejects.toThrow();
		await expect(
			asAgent(s.t, await addAgent(s.t)).query(
				api.infra.agent.volumeReferences,
				args,
			),
		).rejects.toThrow(/Lease lost/);
		await expect(
			s.agent.query(api.infra.agent.volumeReferences, {
				...args,
				leaseId: "stale",
			}),
		).rejects.toThrow(/Lease lost/);
		await expect(
			s.agent.query(api.infra.agent.volumeReferences, {
				...lease,
				volumeNames: Array.from({ length: 201 }, (_, i) => `v${i}`),
			}),
		).rejects.toThrow(/At most 200/);
	});
});

describe("what the removal reports back", () => {
	test("kept and removed volumes are stored on the job its requester reads", async () => {
		const s = await seed();
		const shop = await s.compose("Shop", OWNER_FILE);
		const jobId = await s.alice.mutation(api.compose.crud.remove, {
			composeId: shop,
			deleteVolumes: true,
		});
		if (!jobId) throw new Error("expected a job");
		const lease = await s.claim();
		await s.agent.mutation(api.agent.complete, {
			...lease,
			result: {
				kind: "volumes.removal",
				removed: ["shop_data"],
				kept: [
					{
						name: "shared-files",
						reason: "still used by Blog (Compose service)",
					},
				],
			},
		});
		const job = await s.alice.query(api.jobs.get, { jobId });
		expect(job?.status).toBe("succeeded");
		expect(job?.volumeRemoval).toEqual({
			removed: ["shop_data"],
			kept: [
				{
					name: "shared-files",
					reason: "still used by Blog (Compose service)",
				},
			],
		});
		await expect(
			asUser(s.t, "mallory").query(api.jobs.get, { jobId }),
		).rejects.toThrow();
	});

	test("removals return their job; the hint is stored only with volumes", async () => {
		const s = await seed();
		const kept = await s.compose("Kept", OWNER_FILE);
		const jobId = await s.alice.mutation(api.compose.crud.remove, {
			composeId: kept,
			deletingTogether: ["blog-abc123"],
		});
		const spec = await s.t.run(async (ctx) =>
			jobId ? (await ctx.db.get("jobs", jobId))?.spec : null,
		);
		expect(spec).toEqual({
			kind: "compose.remove",
			appName: expect.any(String),
			composeType: "docker-compose",
			deleteVolumes: false,
		});
		expect(
			await s.alice.mutation(api.compose.crud.remove, { composeId: kept }),
		).toBeNull();
	});
});

describe("what an application or database removal is queued with", () => {
	const twoApps = async () => {
		const s = await seed();
		const create = (name: string) =>
			s.alice.mutation(api.applications.applications.create, {
				environmentId: s.environmentId,
				name,
			});
		const web = await create("Web");
		const billing = await create("Billing");
		for (const [applicationId, volumeName] of [
			[web, "uploads"],
			[web, "shared"],
			[billing, "shared"],
		] as const) {
			await s.alice.mutation(api.applications.mounts.create, {
				applicationId,
				mount: { type: "volume", volumeName, mountPath: `/${volumeName}` },
			});
		}
		const appName = (id: Id<"applications">) =>
			s.t.run(
				async (ctx) => (await ctx.db.get("applications", id))?.appName ?? "",
			);
		const removeSpec = (jobId: Id<"jobs"> | null) =>
			s.t.run(async (ctx) =>
				jobId ? (await ctx.db.get("jobs", jobId))?.spec : null,
			);
		return { ...s, web, billing, appName, removeSpec };
	};

	test("a volume another service names never reaches the job, only its report", async () => {
		const s = await twoApps();
		const jobId = await s.alice.mutation(api.applications.applications.remove, {
			applicationId: s.web,
			deleteVolumes: true,
		});
		// An agent that predates the host checks removes what it is sent:
		// the shared volume is not sent.
		expect(await s.removeSpec(jobId)).toEqual({
			kind: "application.remove",
			appName: expect.any(String),
			removeService: true,
			volumeNames: ["uploads"],
			keptVolumes: [
				{ name: "shared", reason: "still used by Billing (application)" },
			],
		});
	});

	test("deleted together, the shared volume is a candidate the job waits for", async () => {
		const s = await twoApps();
		const billingName = await s.appName(s.billing);
		const jobId = await s.alice.mutation(api.applications.applications.remove, {
			applicationId: s.web,
			deleteVolumes: true,
			deletingTogether: [billingName, "no-such-service"],
		});
		expect(await s.removeSpec(jobId)).toMatchObject({
			volumeNames: ["uploads", "shared"],
			deletingTogether: [billingName, "no-such-service"],
		});
		expect(await s.removeSpec(jobId)).not.toHaveProperty("keptVolumes");
	});

	test("naming a service the caller cannot reach does not free its volume", async () => {
		const s = await twoApps();
		await grantMember(s.t, "org1", "bob", {
			services: [s.web],
			flags: { canDeleteServices: true },
		});
		const jobId = await asUser(s.t, "bob").mutation(
			api.applications.applications.remove,
			{
				applicationId: s.web,
				deleteVolumes: true,
				deletingTogether: [await s.appName(s.billing)],
			},
		);
		expect(await s.removeSpec(jobId)).toMatchObject({
			volumeNames: ["uploads"],
			keptVolumes: [
				{ name: "shared", reason: "still used by another service" },
			],
		});
	});

	test("a database's data volume a compose file borrows is kept the same way", async () => {
		const s = await seed();
		const databaseId = await s.alice.action(api.databases.databases.create, {
			environmentId: s.environmentId,
			engine: "postgres",
			name: "Main DB",
			databaseName: "shop",
			databaseUser: "shop",
			databasePassword: "pgpass",
		});
		const appName = await s.t.run(
			async (ctx) => (await ctx.db.get("databases", databaseId))?.appName ?? "",
		);
		await s.compose(
			"Reports",
			`services:\n  job:\n    image: alpine\nvolumes:\n  data:\n    external: true\n    name: ${appName}-data\n`,
		);
		const jobId = await s.alice.mutation(api.databases.databases.remove, {
			databaseId,
			deleteVolumes: true,
		});
		const spec = await s.t.run(async (ctx) =>
			jobId ? (await ctx.db.get("jobs", jobId))?.spec : null,
		);
		expect(spec).toEqual({
			kind: "databases.remove",
			appName,
			volumeNames: [],
			keptVolumes: [
				{
					name: `${appName}-data`,
					reason: "still used by Reports (Compose service)",
				},
			],
		});
	});
});

describe("the delete dialog's volume plan", () => {
	test("names each volume and why one would be kept; together, shared ones go", async () => {
		const s = await seed();
		const shop = await s.compose("Shop", OWNER_FILE);
		const blog = await s.compose("Blog", BORROWER_FILE);
		const shopName = await s.appNameOf(shop);
		const blogName = await s.appNameOf(blog);
		const target = (id: string) => ({ kind: "compose" as const, id });

		expect(
			await s.alice.query(api.environments.deletableVolumes, {
				organizationId: "org1",
				targets: [target(shop)],
			}),
		).toEqual([
			{
				appName: shopName,
				volumes: [
					{ name: `${shopName}_data`, keptBecause: null },
					{
						name: "shared-files",
						keptBecause: "still used by Blog (Compose service)",
					},
				],
			},
		]);
		// The borrower owns nothing: deleting it alone removes no volume.
		expect(
			await s.alice.query(api.environments.deletableVolumes, {
				organizationId: "org1",
				targets: [target(shop), target(blog)],
			}),
		).toEqual([
			{
				appName: shopName,
				volumes: [
					{ name: `${shopName}_data`, keptBecause: null },
					{ name: "shared-files", keptBecause: null },
				],
			},
			{ appName: blogName, volumes: [] },
		]);
	});

	test("a member is not told the name of a service they cannot see", async () => {
		const s = await seed();
		const shop = await s.compose("Shop", OWNER_FILE);
		await s.compose("Blog", BORROWER_FILE);
		await grantMember(s.t, "org1", "bob", { services: [shop] });
		const [plan] = await asUser(s.t, "bob").query(
			api.environments.deletableVolumes,
			{ organizationId: "org1", targets: [{ kind: "compose", id: shop }] },
		);
		expect(plan?.volumes?.[1]).toEqual({
			name: "shared-files",
			keptBecause: "still used by another service",
		});
	});
});
