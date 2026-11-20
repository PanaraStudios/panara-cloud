import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import {
	addMember,
	asUser,
	grantMember,
	setup,
	type TestConvex,
} from "../test.setup";
import { presignGetUrl } from "./downloads";

const SECRET_KEY = "minio-secret-key-123";

const seed = async (t: TestConvex) => {
	await addMember(t, "org1", "alice", "admin");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "eve", "owner");
	const alice = asUser(t, "alice");
	const { environmentId } = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "shop",
	});
	const databaseId = await alice.action(api.databases.databases.create, {
		environmentId,
		engine: "postgres",
		name: "Main DB",
		databaseName: "shop",
		databaseUser: "shop",
		databasePassword: "pgpass",
	});
	const destinationId = await alice.action(api.databases.destinations.create, {
		organizationId: "org1",
		name: "minio",
		accessKey: "minio-access",
		bucket: "backups",
		region: "us-east-1",
		endpoint: "http://10.0.0.5:9000",
		additionalFlags: [],
		secretAccessKey: SECRET_KEY,
	});
	const backupId = await alice.mutation(api.databases.backups.create, {
		owner: { kind: "database", id: databaseId },
		databaseType: "postgres",
		database: "shop",
		destinationId,
		cronExpression: "0 9 * * *",
		enabled: false,
		prefix: "/daily/",
	});
	const database = await t.run((ctx) => ctx.db.get("databases", databaseId));
	return { backupId, databaseId, appName: database?.appName ?? "" };
};

describe("backup downloads", () => {
	test("signs like AWS's SigV4 presigned URL example", async () => {
		const url = await presignGetUrl({
			protocol: "https:",
			host: "examplebucket.s3.amazonaws.com",
			path: "/test.txt",
			region: "us-east-1",
			accessKey: "AKIAIOSFODNN7EXAMPLE",
			secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			date: new Date("2013-05-24T00:00:00Z"),
			expiresSeconds: 86400,
		});
		expect(url).toContain(
			"X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
		);
	});

	test("admins get a presigned link inside the backup's folder", async () => {
		const t = setup();
		const { backupId, appName } = await seed(t);
		const { url } = await asUser(t, "alice").action(
			api.databases.downloads.getDownloadUrl,
			{ backupId, fileName: "2026-01-01T00-00-00.sql.gz" },
		);
		expect(url).toMatch(
			new RegExp(
				`^http://10\\.0\\.0\\.5:9000/backups/${appName}/daily/2026-01-01T00-00-00\\.sql\\.gz\\?`,
			),
		);
		expect(url).toContain("X-Amz-Credential=minio-access%2F");
		expect(url).not.toContain(SECRET_KEY);
	});

	test("rejects members without the service, other organizations and foreign paths", async () => {
		const t = setup();
		const { backupId, databaseId } = await seed(t);
		const fileName = "a.sql.gz";
		await expect(
			asUser(t, "bob").action(api.databases.downloads.getDownloadUrl, {
				backupId,
				fileName,
			}),
		).rejects.toThrow(/access to this service/);
		await grantMember(t, "org1", "bob", { services: [databaseId] });
		const { url } = await asUser(t, "bob").action(
			api.databases.downloads.getDownloadUrl,
			{ backupId, fileName },
		);
		expect(url).toContain(fileName);
		await expect(
			asUser(t, "eve").action(api.databases.downloads.getDownloadUrl, {
				backupId,
				fileName,
			}),
		).rejects.toThrow(/Not a member/);
		for (const bad of [
			"../x.sql.gz",
			"x/y.sql.gz",
			".hidden.sql.gz",
			"a.zip",
		]) {
			await expect(
				asUser(t, "alice").action(api.databases.downloads.getDownloadUrl, {
					backupId,
					fileName: bad,
				}),
			).rejects.toThrow(/Invalid backup file name/);
		}
	});
});
