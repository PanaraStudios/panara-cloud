import type { Host } from "../host/types";
import { quote } from "../lib/shell";
import {
	applyRetention,
	backupTimestamp,
	type Destination,
	rcloneFlags,
	remote,
	runRclone,
} from "./rclone";
import { exportLine } from "./script";

export type BackupEngine =
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "libsql";

export type ContainerTarget =
	| { kind: "swarm"; appName: string }
	| {
			kind: "compose";
			appName: string;
			serviceName: string;
			composeType: "docker-compose" | "stack";
	  };

export type DatabaseCredentials = {
	databaseUser?: string;
	password: string;
	rootPassword?: string;
};

export type BackupInput = {
	databaseType: BackupEngine;
	database: string;
	customName?: string;
	keepLatestCount?: number;
	// "<appName>/<prefix>/" inside the bucket.
	folder: string;
	target: ContainerTarget;
	credentials: DatabaseCredentials;
	destination: Destination;
};

export type RestoreInput = {
	databaseType: BackupEngine;
	databaseName: string;
	backupFile: string;
	target: ContainerTarget;
	credentials: DatabaseCredentials;
	destination: Destination;
};

type Options = { log: (text: string) => void; signal?: AbortSignal };

export const BACKUP_EXTENSION: Record<BackupEngine, string> = {
	postgres: "sql.gz",
	mysql: "sql.gz",
	mariadb: "sql.gz",
	mongo: "bson.gz",
	libsql: "sql.gz",
};

// Finds a service's running container. A plain (docker compose) container
// can carry any com.docker.swarm.* or com.docker.stack.* label it likes, so
// swarm targets are matched by the real service's ID, which swarm sets on
// its own task containers. Compose overwrites the com.docker.compose.*
// labels on every container it creates, so those can't be borrowed.
export const runningContainerScript = (
	filters: string[],
	swarmService?: string,
	head = "head -n 1",
): string => {
	const ps = (extra: string) =>
		`docker ps -q --no-trunc --filter status=running ${[...filters.map((f) => `--filter ${quote(f)}`), extra].join(" ")} | ${head}`;
	if (!swarmService) return ps("");
	return `sid=$(docker service inspect --format '{{.ID}}' ${quote(swarmService)} 2>/dev/null || true); if [ -n "$sid" ]; then ${ps('--filter "label=com.docker.swarm.service.id=$sid"')}; fi`;
};

export const containerLookup = (target: ContainerTarget): string =>
	target.kind === "swarm"
		? runningContainerScript([], target.appName)
		: target.composeType === "stack"
			? runningContainerScript(
					[`label=com.docker.stack.namespace=${target.appName}`],
					`${target.appName}_${target.serviceName}`,
				)
			: runningContainerScript([
					`label=com.docker.compose.project=${target.appName}`,
					`label=com.docker.compose.service=${target.serviceName}`,
				]);

// Values reach the container as `docker exec -e NAME` (no value), which
// copies them from the script's environment: they never appear in argv, and
// the inner commands only reference "$DB_*" (MySQL clients read MYSQL_PWD).
const credentialEnv = (
	type: BackupEngine,
	database: string,
	credentials: DatabaseCredentials,
) => {
	const password =
		type === "mysql"
			? (credentials.rootPassword ?? credentials.password)
			: credentials.password;
	return [
		exportLine("DB_NAME", database),
		exportLine("DB_USER", credentials.databaseUser ?? ""),
		exportLine("DB_PASS", password),
		exportLine("NS_FROM", "$src$.$coll$"),
		exportLine("NS_TO", `${database}.$coll$`),
	].join("\n");
};

const EXEC_ENV = "-e DB_NAME -e DB_USER -e DB_PASS";

export const dumpCommand = (type: BackupEngine): string => {
	switch (type) {
		case "postgres":
			return `docker exec ${EXEC_ENV} "$CONTAINER_ID" bash -c 'set -o pipefail; pg_dump -Fc --no-acl --no-owner -h localhost -U "$DB_USER" --no-password "$DB_NAME" | gzip'`;
		case "mysql":
			return `docker exec ${EXEC_ENV} "$CONTAINER_ID" bash -c 'set -o pipefail; MYSQL_PWD="$DB_PASS" mysqldump --default-character-set=utf8mb4 -u root --single-transaction --no-tablespaces --quick "$DB_NAME" | gzip'`;
		case "mariadb":
			return `docker exec ${EXEC_ENV} "$CONTAINER_ID" bash -c 'set -o pipefail; MYSQL_PWD="$DB_PASS" mariadb-dump --user="$DB_USER" --single-transaction --quick --databases "$DB_NAME" | gzip'`;
		case "mongo":
			return `docker exec ${EXEC_ENV} "$CONTAINER_ID" bash -c 'mongodump -d "$DB_NAME" -u "$DB_USER" -p "$DB_PASS" --archive --authenticationDatabase admin --gzip'`;
		case "libsql":
			return `docker exec ${EXEC_ENV} "$CONTAINER_ID" sh -c 'tar cf - -C /var/lib/sqld "$DB_NAME" | gzip'`;
	}
};

// Dumps taken with `--databases` carry USE/CREATE DATABASE statements that
// would redirect the restore away from the chosen database.
const STRIP_DATABASE_SWITCH = `grep -viE '^[[:space:]]*(use|create[[:space:]]+database)[[:space:]]'`;

export const restorePipeline = (type: BackupEngine): string => {
	switch (type) {
		case "postgres":
			return `gunzip | docker exec -i ${EXEC_ENV} "$CONTAINER_ID" sh -c 'pg_restore -U "$DB_USER" -d "$DB_NAME" -O --clean --if-exists'`;
		case "mysql":
			return `gunzip | ${STRIP_DATABASE_SWITCH} | docker exec -i ${EXEC_ENV} "$CONTAINER_ID" sh -c 'MYSQL_PWD="$DB_PASS" mysql -u root "$DB_NAME"'`;
		case "mariadb":
			return `gunzip | ${STRIP_DATABASE_SWITCH} | docker exec -i ${EXEC_ENV} "$CONTAINER_ID" sh -c 'MYSQL_PWD="$DB_PASS" mariadb -u "$DB_USER" "$DB_NAME"'`;
		case "mongo":
			// Renames whatever database the archive holds to the chosen one.
			return `docker exec -i ${EXEC_ENV} -e NS_FROM -e NS_TO "$CONTAINER_ID" sh -c 'mongorestore --username "$DB_USER" --password "$DB_PASS" --authenticationDatabase admin --archive --gzip --drop --nsFrom="$NS_FROM" --nsTo="$NS_TO"'`;
		case "libsql":
			return `docker exec -i "$CONTAINER_ID" sh -c 'tar xzf - -C /var/lib/sqld'`;
	}
};

export const backupFileName = (
	type: BackupEngine,
	customName: string | undefined,
	date = new Date(),
) =>
	`${[customName, backupTimestamp(date)].filter(Boolean).join("-")}.${BACKUP_EXTENSION[type]}`;

const findContainer = (
	target: ContainerTarget,
) => `CONTAINER_ID=$(${containerLookup(target)})
if [ -z "$CONTAINER_ID" ]; then
	echo "❌ Error: Container not found, make sure the database is running"
	exit 1
fi
echo "Container Up: $CONTAINER_ID"`;

// Streams the dump straight from the container to the bucket (nothing is
// written to the host's disk), then prunes old files when keepLatestCount is
// set. Returns the uploaded path inside the bucket.
export const runDatabaseBackup = async (
	host: Host,
	input: BackupInput,
	options: Options & { now?: Date },
): Promise<{ file: string; pruned: string[] }> => {
	const file = `${input.folder}${backupFileName(input.databaseType, input.customName, options.now)}`;
	const target = remote(input.destination, file);
	const flags = rcloneFlags(input.destination);
	const script = `${credentialEnv(input.databaseType, input.database, input.credentials)}
echo "[$(date)] Starting backup of $DB_NAME"
${findContainer(input.target)}
echo "[$(date)] Uploading to "${quote(file)}
if ! { ${dumpCommand(input.databaseType)} | rclone rcat ${flags} ${target}; }; then
	rclone deletefile ${flags} ${target} >/dev/null 2>&1 || true
	echo "❌ Error: Backup failed"
	exit 1
fi
echo "[$(date)] ✅ Backup uploaded"`;
	await runRclone(host, input.destination, script, {
		onOutput: options.log,
		signal: options.signal,
		secrets: [input.credentials.password, input.credentials.rootPassword],
	});
	const pruned = await applyRetention(
		host,
		input.destination,
		input.folder,
		`*.${BACKUP_EXTENSION[input.databaseType]}`,
		input.keepLatestCount,
		{ signal: options.signal },
	);
	for (const path of pruned) options.log(`Removed old backup ${path}\n`);
	return { file, pruned };
};

export const restoreDatabaseBackup = async (
	host: Host,
	input: RestoreInput,
	options: Options,
) => {
	const script = `${credentialEnv(input.databaseType, input.databaseName, input.credentials)}
echo "Starting restore..."
echo ${quote(`Restoring database: ${input.databaseName} from ${input.backupFile}`)}
${findContainer(input.target)}
rclone cat ${rcloneFlags(input.destination)} ${remote(input.destination, input.backupFile)} | ${restorePipeline(input.databaseType)}
echo "Restore completed successfully!"`;
	await runRclone(host, input.destination, script, {
		onOutput: options.log,
		signal: options.signal,
		secrets: [input.credentials.password, input.credentials.rootPassword],
	});
};
