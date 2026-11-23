import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { assertGitUrl } from "../sources/lib";
import {
	addMember,
	addServer,
	asUser,
	setup,
	type TestConvex,
} from "../test.setup";
import { rcloneFlagError } from "./rcloneFlags";

const destinationArgs = {
	organizationId: "org1",
	name: "minio",
	accessKey: "a",
	secretAccessKey: "s",
	bucket: "b",
	region: "us-east-1",
	endpoint: "http://10.0.0.5:9000",
	additionalFlags: [] as string[],
};

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "admin");
	const alice = asUser(t, "alice");
	const { environmentId } = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "Shop",
	});
	const serverId = await addServer(t, "org1");
	const composeId = await alice.mutation(api.compose.crud.create, {
		environmentId,
		name: "stack",
		serverId,
		composeFile: "services:\n  db:\n    image: postgres\n",
	});
	const destinationId = await alice.action(
		api.databases.destinations.create,
		destinationArgs,
	);
	return { t, alice, environmentId, serverId, composeId, destinationId };
};

const appName = async (t: TestConvex, composeId: string) =>
	(await t.run((ctx) => ctx.db.get("compose", composeId as never)))?.appName;

describe("rclone flags", () => {
	test("only harmless S3 and transfer flags are accepted", async () => {
		for (const flag of [
			"--rc",
			"--rc-addr=0.0.0.0:5572",
			"--config=/etc/shadow",
			"--log-file=/root/x",
			"--password-command=id",
			"--s3-env-auth",
			"--ca-cert=/etc/ssl/x",
			"--x; rm -rf /",
		]) {
			expect(rcloneFlagError(flag), flag).not.toBeNull();
		}
		for (const flag of [
			"--s3-sign-accept-encoding=false",
			"--transfers=8",
			"--s3-chunk-size=64M",
		]) {
			expect(rcloneFlagError(flag), flag).toBeNull();
		}
		const { alice } = await seed();
		await expect(
			alice.action(api.databases.destinations.create, {
				...destinationArgs,
				additionalFlags: ["--config=/etc/panara-cloud/x"],
			}),
		).rejects.toThrow(/is not allowed/);
		await expect(
			alice.action(api.databases.destinations.testConnection, {
				organizationId: "org1",
				draft: {
					name: "minio",
					accessKey: "a",
					secretAccessKey: "s",
					bucket: "b",
					region: "us-east-1",
					endpoint: "http://10.0.0.5:9000",
					additionalFlags: ["--rc"],
				},
			}),
		).rejects.toThrow(/is not allowed/);
		await alice.action(api.databases.destinations.create, {
			...destinationArgs,
			additionalFlags: ["--s3-sign-accept-encoding=false", "--transfers=4"],
		});
	});
});

describe("backup prefixes and service names", () => {
	test("are restricted to safe path characters", async () => {
		const { t, alice, composeId, destinationId } = await seed();
		const owner = { kind: "compose" as const, id: composeId };
		const volumeName = `${await appName(t, composeId)}_data`;
		const volume = (prefix: string, serviceName = "db") =>
			alice.mutation(api.databases.volumeBackups.create, {
				owner,
				destinationId,
				name: "v",
				volumeName,
				prefix,
				serviceName,
				turnOff: false,
				cronExpression: "0 3 * * *",
				enabled: false,
			});
		for (const prefix of ['x"; id; "', "a/../b", "$(id)", "a b"]) {
			await expect(volume(prefix), prefix).rejects.toThrow(/prefix may only/);
		}
		await expect(volume("ok", "db; id")).rejects.toThrow(
			/service name may only/,
		);
		await volume("nightly/2026.v1_a-b");
		const backup = (prefix: string, serviceName = "db") =>
			alice.mutation(api.databases.backups.create, {
				owner,
				destinationId,
				prefix,
				serviceName,
				database: "shop",
				databaseType: "postgres",
				databaseUser: "shop",
				cronExpression: "0 3 * * *",
				enabled: false,
			} as never);
		await expect(backup("`id`")).rejects.toThrow(/prefix may only/);
		await expect(backup("ok", "$(id)")).rejects.toThrow(
			/service name may only/,
		);
	});
});

describe("custom git URLs", () => {
	test("only https, ssh and scp-like URLs are accepted", () => {
		for (const url of [
			"https://github.com/acme/web.git",
			"ssh://git@example.com:2222/acme/web.git",
			"git@github.com:acme/web.git",
		]) {
			expect(() => assertGitUrl(url), url).not.toThrow();
		}
		for (const url of [
			"file:///etc",
			"/etc/panara-cloud",
			"ext::sh -c id",
			"git://example.com/x",
			"http://example.com/x.git",
			"--upload-pack=id",
			"git@host:--upload-pack=id",
			"https://-oProxyCommand=id/x",
		]) {
			expect(() => assertGitUrl(url), url).toThrow(/https:\/\/, ssh:\/\//);
		}
	});

	test("saving an application's git source checks the URL", async () => {
		const { alice, environmentId, serverId } = await seed();
		const applicationId = await alice.mutation(
			api.applications.applications.create,
			{ environmentId, name: "web", serverId },
		);
		const source = {
			type: "git" as const,
			url: "file:///var/lib/docker",
			branch: "main",
			buildPath: "/",
			submodules: false,
			watchPaths: [],
		};
		await expect(
			alice.mutation(api.applications.applications.saveGitSource, {
				applicationId,
				source,
			}),
		).rejects.toThrow(/https:\/\/, ssh:\/\//);
		await alice.mutation(api.applications.applications.saveGitSource, {
			applicationId,
			source: { ...source, url: "https://github.com/acme/web.git" },
		});
	});
});
