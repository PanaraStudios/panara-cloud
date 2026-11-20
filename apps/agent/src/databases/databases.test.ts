import { describe, expect, test } from "vitest";
import {
	backupFileName,
	containerLookup,
	dumpCommand,
	restorePipeline,
} from "./backup";
import { filesToPrune, rcloneEnv, rcloneFlags } from "./rclone";
import {
	buildServiceSpec,
	type DatabaseServiceInput,
	engineEnv,
} from "./service";

type Container = {
	Env?: string[];
	Labels?: Record<string, string>;
	Mounts?: unknown[];
	Args?: string[];
};

const containerOf = (spec: ReturnType<typeof buildServiceSpec>) =>
	(spec.TaskTemplate as { ContainerSpec?: Container } | undefined)
		?.ContainerSpec;

const base: DatabaseServiceInput = {
	databaseId: "db1",
	organizationId: "org1",
	projectId: "p1",
	environmentId: "e1",
	engine: "postgres",
	name: "Main",
	appName: "main-abc123",
	dockerImage: "postgres:17",
	replicas: 1,
	env: "",
	projectEnv: "",
	environmentEnv: "",
	credentials: {
		databaseName: "shop",
		databaseUser: "shop",
		password: "pw#1",
	},
	mounts: [
		{
			type: "volume",
			volumeName: "main-abc123-data",
			mountPath: "/var/lib/postgresql/data",
		},
	],
};

describe("database service spec", () => {
	test("postgres: env, labels, stop-first updates, no ports by default", () => {
		const spec = buildServiceSpec({ ...base, env: "TZ=UTC" });
		const container = containerOf(spec);
		expect(container?.Env).toEqual([
			"POSTGRES_DB=shop",
			"POSTGRES_USER=shop",
			"POSTGRES_PASSWORD=pw#1",
			"TZ=UTC",
		]);
		expect(container?.Labels).toMatchObject({
			"panara-cloud.managed": "true",
			"panara-cloud.service.kind": "database",
			"panara-cloud.service.id": "db1",
		});
		expect(container?.Mounts).toEqual([
			{
				Type: "volume",
				Source: "main-abc123-data",
				Target: "/var/lib/postgresql/data",
				VolumeOptions: { Labels: { "panara-cloud.managed": "true" } },
			},
		]);
		expect(spec.UpdateConfig).toMatchObject({ Order: "stop-first" });
		expect(spec.EndpointSpec).toEqual({ Mode: "dnsrr", Ports: [] });
		expect(spec.TaskTemplate?.Placement).toEqual({
			Constraints: ["node.role==manager"],
		});
	});

	test("external ports publish in host mode on the engine's port", () => {
		expect(
			buildServiceSpec({ ...base, engine: "mongo", externalPort: 15417 })
				.EndpointSpec?.Ports,
		).toEqual([
			{
				Protocol: "tcp",
				TargetPort: 27017,
				PublishedPort: 15417,
				PublishMode: "host",
			},
		]);
		expect(
			buildServiceSpec({
				...base,
				engine: "libsql",
				externalPort: 15480,
				externalAdminPort: 15481,
			}).EndpointSpec?.Ports?.map((p) => [p.TargetPort, p.PublishedPort]),
		).toEqual([
			[8080, 15480],
			[5000, 15481],
		]);
	});

	test("redis reads its password from the env, not the args", () => {
		const spec = buildServiceSpec({ ...base, engine: "redis" });
		const container = containerOf(spec);
		expect(JSON.stringify(container?.Args)).not.toContain("pw#1");
		expect(container?.Env).toContain("REDIS_PASSWORD=pw#1");
	});

	test("mysql with a root user only sets the root password", () => {
		expect(
			engineEnv({
				...base,
				engine: "mysql",
				credentials: {
					databaseName: "shop",
					databaseUser: "root",
					password: "x",
					rootPassword: "rootpw",
				},
			}),
		).toBe('MYSQL_DATABASE="shop"\nMYSQL_ROOT_PASSWORD="rootpw"');
	});

	test("user env can reference project variables", () => {
		const spec = buildServiceSpec({
			...base,
			env: "REGION=${{project.REGION}}",
			projectEnv: "REGION=eu",
		});
		expect(containerOf(spec)?.Env).toContain("REGION=eu");
	});
});

describe("backup commands", () => {
	test("credentials never appear in the generated commands", () => {
		for (const type of [
			"postgres",
			"mysql",
			"mariadb",
			"mongo",
			"libsql",
		] as const) {
			expect(dumpCommand(type)).not.toMatch(/-e DB_PASS=/);
			expect(restorePipeline(type)).not.toMatch(/-e DB_PASS=/);
		}
		const env = rcloneEnv({
			accessKey: "AK",
			secretAccessKey: "it's secret",
			bucket: "b",
			region: "r",
			endpoint: "http://e",
			additionalFlags: ["--s3-sign-accept-encoding=false", "--x;rm"],
		});
		expect(env).toContain(`export RCLONE_S3_SECRET_ACCESS_KEY="it's secret"`);
		expect(
			rcloneFlags({
				accessKey: "AK",
				secretAccessKey: "s",
				bucket: "b",
				region: "r",
				endpoint: "e",
				additionalFlags: [
					"--s3-upload-concurrency=8",
					"--no-check-certificate",
					"--x;rm",
					"--config=/tmp/evil.conf",
					"--log-file=/etc/cron.d/x",
					"--rc",
					"--rc-addr=0.0.0.0:5572",
					"--password-command=id",
					"--s3-env-auth",
					"--ca-cert=/root/.ssh/id_rsa",
					"--files-from=/etc/shadow",
				],
			}),
		).toBe("--s3-upload-concurrency=8 --no-check-certificate");
	});

	test("swarm containers are matched by the real service ID, never a forgeable name label", () => {
		const swarm = containerLookup({ kind: "swarm", appName: "pg-1" });
		const stack = containerLookup({
			kind: "compose",
			appName: "shop",
			serviceName: "db",
			composeType: "stack",
		});
		expect(swarm).toContain("docker service inspect --format '{{.ID}}' pg-1");
		expect(stack).toContain(
			"docker service inspect --format '{{.ID}}' shop_db",
		);
		for (const lookup of [swarm, stack]) {
			expect(lookup).toContain('"label=com.docker.swarm.service.id=$sid"');
			expect(lookup).not.toContain("com.docker.swarm.service.name");
		}
		expect(
			containerLookup({
				kind: "compose",
				appName: "shop",
				composeType: "docker-compose",
				serviceName: "db",
			}),
		).toContain("label\\=com.docker.compose.project\\=shop");
	});

	test("file names carry the custom name, timestamp and engine extension", () => {
		const date = new Date("2026-01-15T09:00:00.123Z");
		expect(backupFileName("postgres", "nightly", date)).toBe(
			"nightly-2026-01-15T09-00-00-123Z.sql.gz",
		);
		expect(backupFileName("mongo", undefined, date)).toBe(
			"2026-01-15T09-00-00-123Z.bson.gz",
		);
	});

	test("retention keeps the newest files by server modtime", () => {
		const file = (name: string, time: string) => ({
			Path: `pg/${name}`,
			Name: name,
			Size: 1,
			IsDir: false,
			ModTime: time,
		});
		const files = [
			file("b.sql.gz", "2026-01-02T00:00:00Z"),
			file("custom.sql.gz", "2026-01-04T00:00:00Z"),
			file("a.sql.gz", "2026-01-01T00:00:00Z"),
			file("c.sql.gz", "2026-01-03T00:00:00Z"),
		];
		expect(filesToPrune(files, 2).map((f) => f.Name)).toEqual([
			"b.sql.gz",
			"a.sql.gz",
		]);
		expect(filesToPrune(files, 0)).toEqual([]);
		expect(filesToPrune(files, 10)).toEqual([]);
	});
});
