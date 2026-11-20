import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import {
	addMember,
	addServer,
	asUser,
	grantMember,
	setup,
} from "../test.setup";

const COMPOSE = "services:\n  web:\n    image: nginx\n";

// bob is a member of org1 given only the "mine" compose service.
const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "admin");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "eve", "owner");
	const alice = asUser(t, "alice");
	const bob = asUser(t, "bob");
	const { environmentId } = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "Shop",
	});
	const serverId = await addServer(t, "org1");
	const create = (name: string) =>
		alice.mutation(api.compose.crud.create, {
			environmentId,
			name,
			serverId,
			composeFile: COMPOSE,
		});
	const mine = await create("mine");
	const theirs = await create("theirs");
	await grantMember(t, "org1", "bob", {
		services: [mine],
		flags: { canCreateServices: true },
	});
	const appNameOf = async (id: typeof mine) =>
		(await t.run((ctx) => ctx.db.get("compose", id)))?.appName ?? "";
	return { t, alice, bob, serverId, mine, theirs, appNameOf };
};

describe("service-scoped operations", () => {
	test("file mounts are read through the owning service's grant", async () => {
		const { alice, bob, mine, theirs } = await seed();
		const file = {
			type: "file" as const,
			filePath: "conf/app.conf",
			content: "x",
			mountPath: "",
		};
		const own = await alice.mutation(api.compose.mounts.add, {
			composeId: mine,
			mount: file,
		});
		const other = await alice.mutation(api.compose.mounts.add, {
			composeId: theirs,
			mount: file,
		});
		await expect(
			bob.mutation(api.infra.mounts.readFileOnHost, { mountId: other }),
		).rejects.toThrow(/access to this service/);
		expect(
			await bob.mutation(api.infra.mounts.readFileOnHost, { mountId: own }),
		).toBeTruthy();
	});

	test("compose deployment history follows the service grant", async () => {
		const { t, alice, bob, mine, theirs } = await seed();
		await alice.mutation(api.compose.deploy.deploy, { composeId: theirs });
		await expect(
			bob.mutation(api.compose.deploy.clearDeployments, { composeId: theirs }),
		).rejects.toThrow(/access to this service/);
		const [deployment] = await alice.query(api.compose.deploy.listDeployments, {
			composeId: theirs,
		});
		if (!deployment) throw new Error("no deployment");
		await t.run((ctx) =>
			ctx.db.patch("jobs", deployment.jobId, { status: "failed" }),
		);
		await expect(
			bob.mutation(api.compose.deploy.removeDeployment, {
				deploymentId: deployment._id,
			}),
		).rejects.toThrow(/access to this service/);
		await bob.mutation(api.compose.deploy.clearDeployments, {
			composeId: mine,
		});
		await alice.mutation(api.compose.deploy.removeDeployment, {
			deploymentId: deployment._id,
		});
	});

	test("container lists only take the caller's own services", async () => {
		const { alice, bob, serverId, mine, theirs, appNameOf } = await seed();
		const list = (who: typeof bob, appName: string, org = "org1") =>
			who.mutation(api.infra.docker.listAppContainers, {
				organizationId: org,
				serverId: org === "org1" ? serverId : undefined,
				appName,
			});
		await expect(list(bob, await appNameOf(theirs))).rejects.toThrow(
			/access to this service/,
		);
		await expect(list(bob, "panara-cloud")).rejects.toThrow(
			/Service not found/,
		);
		expect(await list(bob, await appNameOf(mine))).toBeTruthy();
		expect(await list(alice, "anything")).toBeTruthy();
	});

	test("members browse only their services' backup folders", async () => {
		const { alice, bob, mine, theirs, appNameOf } = await seed();
		const destinationId = await alice.action(
			api.databases.destinations.create,
			{
				organizationId: "org1",
				name: "minio",
				accessKey: "a",
				secretAccessKey: "s",
				bucket: "b",
				region: "us-east-1",
				endpoint: "http://10.0.0.5:9000",
				additionalFlags: [],
			},
		);
		const browse = (who: typeof bob, search: string) =>
			who.mutation(api.databases.destinations.listFiles, {
				destinationId,
				search,
			});
		await expect(browse(bob, "")).rejects.toThrow(/backup folder/);
		await expect(
			browse(bob, `${await appNameOf(theirs)}_web/`),
		).rejects.toThrow(/access to this service/);
		expect(await browse(bob, `${await appNameOf(mine)}_web/2026`)).toBeTruthy();
		expect(await browse(alice, "")).toBeTruthy();
	});
});
