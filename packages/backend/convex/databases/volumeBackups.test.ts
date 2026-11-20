import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { addMember, addServer, asUser, setup } from "../test.setup";

const destinationArgs = {
	name: "minio",
	provider: "Minio",
	accessKey: "minio-access",
	secretAccessKey: "minio-secret",
	bucket: "backups",
	region: "us-east-1",
	endpoint: "http://10.0.0.5:9000",
	additionalFlags: [],
};

const COMPOSE =
	"services:\n  web:\n    image: nginx\nvolumes:\n  data: {}\n  shared:\n    name: shared-data\n";

const fields = (volumeName: string) => ({
	name: "nightly",
	volumeName,
	prefix: "",
	serviceName: "web",
	turnOff: false,
	cronExpression: "0 3 * * *",
	enabled: true,
});

// org1 (oldest membership) is the root organization; alice is the instance
// administrator, eve owns another organization.
const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "admin");
	await addMember(t, "org2", "eve", "owner");
	const alice = asUser(t, "alice");
	const eve = asUser(t, "eve");
	const other = await eve.mutation(api.projects.create, {
		organizationId: "org2",
		name: "Other",
	});
	const serverId = await addServer(t, "org2");
	const composeId = await eve.mutation(api.compose.crud.create, {
		environmentId: other.environmentId,
		name: "stack",
		serverId,
		composeFile: COMPOSE,
	});
	const compose = await t.run((ctx) => ctx.db.get("compose", composeId));
	const destinationId = await eve.action(api.databases.destinations.create, {
		organizationId: "org2",
		...destinationArgs,
	});
	const owner = { kind: "compose" as const, id: composeId };
	return { t, alice, eve, owner, appName: compose?.appName, destinationId };
};

describe("volume backups only touch the service's own volumes", () => {
	test("reserved and foreign volumes are refused; declared ones work", async () => {
		const { eve, owner, appName, destinationId } = await seed();
		const create = (volumeName: string) =>
			eve.mutation(api.databases.volumeBackups.create, {
				owner,
				destinationId,
				...fields(volumeName),
			});
		await expect(create("panara-cloud-convex-data")).rejects.toThrow(
			/reserved for Panara Cloud/,
		);
		await expect(create("someone-elses-data")).rejects.toThrow(
			/not a volume of this service/,
		);
		const id = await create(`${appName}_data`);
		await create("shared-data");
		await expect(
			eve.mutation(api.databases.volumeBackups.update, {
				volumeBackupId: id,
				destinationId,
				...fields("panara-cloud-convex-data"),
			}),
		).rejects.toThrow(/reserved for Panara Cloud/);
		await expect(
			eve.mutation(api.databases.volumeBackups.restore, {
				owner,
				serviceName: "web",
				destinationId,
				volumeName: "panara-cloud-convex-data",
				backupFile: "x.tar",
			}),
		).rejects.toThrow(/reserved for Panara Cloud/);
		await expect(
			eve.mutation(api.databases.volumeBackups.restore, {
				owner,
				serviceName: "web",
				destinationId,
				volumeName: "someone-elses-data",
				backupFile: "x.tar",
			}),
		).rejects.toThrow(/not a volume of this service/);
	});

	test("an existing backup of a foreign volume is disabled when it fires", async () => {
		const { t, owner, destinationId } = await seed();
		const id = await t.run((ctx) =>
			ctx.db.insert("volumeBackups", {
				organizationId: "org2",
				owner,
				destinationId,
				...fields("panara-cloud-convex-data"),
				generation: 0,
			}),
		);
		await t.mutation(internal.databases.volumeBackups.fire, {
			volumeBackupId: id,
			generation: 0,
		});
		const row = await t.run((ctx) => ctx.db.get("volumeBackups", id));
		expect(row?.enabled).toBe(false);
		expect(await t.run((ctx) => ctx.db.query("jobs").collect())).toEqual([]);
	});

	test("the instance administrator keeps backing up any volume of the panel host", async () => {
		const { alice } = await seed();
		const root = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Root",
		});
		const composeId = await alice.mutation(api.compose.crud.create, {
			environmentId: root.environmentId,
			name: "stack",
			composeFile: COMPOSE,
		});
		const destinationId = await alice.action(
			api.databases.destinations.create,
			{ organizationId: "org1", ...destinationArgs },
		);
		expect(
			await alice.mutation(api.databases.volumeBackups.create, {
				owner: { kind: "compose", id: composeId },
				destinationId,
				...fields("panara-cloud-convex-data"),
			}),
		).toBeTruthy();
	});
});
