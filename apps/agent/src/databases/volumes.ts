import type { Host } from "../host/types";
import { PANARA_CLOUD_LABEL } from "../lib/constants";
import { quote } from "../lib/shell";
import {
	applyRetention,
	backupTimestamp,
	type Destination,
	formatBytes,
	listFolder,
	rcloneFlags,
	remote,
	runRclone,
} from "./rclone";

export type ServiceControl =
	| { kind: "swarm"; serviceName: string }
	| { kind: "compose"; project: string; serviceName: string };

export type VolumeBackupInput = {
	volumeName: string;
	turnOff: boolean;
	keepLatestCount?: number;
	folder: string;
	service: ServiceControl;
	destination: Destination;
};

export type VolumeRestoreInput = {
	volumeName: string;
	appName?: string;
	backupFile: string;
	destination: Destination;
};

type Options = { log: (text: string) => void; signal?: AbortSignal };

const HELPER_IMAGE = "ubuntu";
const helperLabel = quote(`${PANARA_CLOUD_LABEL}=true`);

const stopCommands = (service: ServiceControl) => {
	if (service.kind === "swarm") {
		const name = quote(service.serviceName);
		return {
			stop: `ACTUAL_REPLICAS=$(docker service inspect ${name} --format '{{.Spec.Mode.Replicated.Replicas}}')
echo "Scaling "${name}" from $ACTUAL_REPLICAS to 0 replicas"
docker service update --replicas=0 ${name} >/dev/null`,
			start: `echo "Scaling "${name}" back to $ACTUAL_REPLICAS replicas"
docker service update --replicas="$ACTUAL_REPLICAS" --with-registry-auth ${name} >/dev/null`,
		};
	}
	return {
		stop: `ID=$(docker ps -q --filter ${quote(`label=com.docker.compose.project=${service.project}`)} --filter ${quote(`label=com.docker.compose.service=${service.serviceName}`)})
echo "Stopping compose container $ID"
[ -n "$ID" ] && docker stop $ID >/dev/null`,
		start: `echo "Starting compose container $ID"
[ -n "$ID" ] && docker start $ID >/dev/null`,
	};
};

// GNU tar exits 1 when a file changes while being read, which is expected on
// a live volume.
const archiveCommand = (volumeName: string) =>
	`docker run --rm --label ${helperLabel} -v ${quote(`${volumeName}:/volume_data:ro`)} ${HELPER_IMAGE} bash -c 'cd /volume_data && tar cf - . ; s=$?; [ $s -eq 0 ] || [ $s -eq 1 ]'`;

// Streams a tar of the volume to the bucket. With turnOff the service is
// stopped first and always restarted afterwards. No local copy is staged, so
// the service stays down for the upload too.
export const runVolumeBackup = async (
	host: Host,
	input: VolumeBackupInput,
	options: Options & { now?: Date },
): Promise<{ file: string; size?: string; pruned: string[] }> => {
	const file = `${input.folder}${input.volumeName}-${backupTimestamp(options.now)}.tar`;
	const target = remote(input.destination, file);
	const flags = rcloneFlags(input.destination);
	const upload = `{ ${archiveCommand(input.volumeName)} | rclone rcat ${flags} ${target}; }`;
	const { stop, start } = stopCommands(input.service);
	const body = input.turnOff
		? `${stop}
set +e
( set -eo pipefail; ${upload} )
BACKUP_STATUS=$?
( set -e
${start}
)
RESTART_STATUS=$?
set -e
if [ "$BACKUP_STATUS" -ne 0 ]; then
	rclone deletefile ${flags} ${target} >/dev/null 2>&1 || true
	[ "$RESTART_STATUS" -ne 0 ] && echo "Service restart also failed with exit code $RESTART_STATUS"
	echo "❌ Error: Volume backup failed"
	exit "$BACKUP_STATUS"
fi
if [ "$RESTART_STATUS" -ne 0 ]; then
	echo "❌ Error: Service restart failed"
	exit "$RESTART_STATUS"
fi`
		: `if ! ${upload}; then
	rclone deletefile ${flags} ${target} >/dev/null 2>&1 || true
	echo "❌ Error: Volume backup failed"
	exit 1
fi`;
	const script = `docker volume inspect ${quote(input.volumeName)} >/dev/null 2>&1 || { echo ${quote(`❌ Error: Volume ${input.volumeName} not found`)}; exit 1; }
echo ${quote(`Volume name: ${input.volumeName}`)}
echo "Turning off service during backup: ${input.turnOff ? "Yes" : "No"}"
echo ${quote(`Uploading to ${file}`)}
${body}
echo "Volume backup done ✅"`;
	await runRclone(host, input.destination, script, {
		onOutput: options.log,
		signal: options.signal,
	});
	let size: string | undefined;
	try {
		const [uploaded] = await listFolder(host, input.destination, file, {
			filesOnly: true,
			signal: options.signal,
		});
		if (uploaded) size = formatBytes(uploaded.Size);
	} catch {}
	const pruned = await applyRetention(
		host,
		input.destination,
		input.folder,
		`${input.volumeName}-*.tar`,
		input.keepLatestCount,
		{ signal: options.signal },
	);
	for (const path of pruned) options.log(`Removed old backup ${path}\n`);
	return { file, size, pruned };
};

// Refuses to overwrite a volume that a container (running or stopped) still
// uses; otherwise replaces it with the archive.
// Stopped containers the panel recreates anyway are removed first: Swarm task
// history (kept after a service is scaled to 0) and the owner's own compose
// project (`docker compose stop` keeps them). Without that, a stopped
// database, application or compose would never be restorable.
export const restoreVolume = async (
	host: Host,
	input: VolumeRestoreInput,
	options: Options,
) => {
	const volume = quote(input.volumeName);
	const script = `echo ${quote(`Volume name: ${input.volumeName}`)}
echo ${quote(`Backup file: ${input.backupFile}`)}
if docker volume inspect ${volume} >/dev/null 2>&1; then
	for owner in label=com.docker.swarm.task.id${input.appName ? ` ${quote(`label=com.docker.compose.project=${input.appName}`)}` : ""}; do
		STALE=$(docker ps -a -q --filter ${quote(`volume=${input.volumeName}`)} --filter "$owner" --filter status=exited --filter status=created --filter status=dead)
		if [ -n "$STALE" ]; then
			echo "Removing stopped containers of this volume ($owner)"
			docker rm $STALE >/dev/null
		fi
	done
	USERS=$(docker ps -a --filter ${quote(`volume=${input.volumeName}`)} --format '{{.Names}} ({{.State}})')
	if [ -n "$USERS" ]; then
		echo ${quote(`⚠️  These containers use volume ${input.volumeName}:`)}
		echo "$USERS"
		echo "Stop or remove them (e.g. stop the service) and run the restore again."
		echo "❌ Volume restore aborted - volume is in use"
		exit 1
	fi
	echo "Removing existing volume"
	docker volume rm --force ${volume} >/dev/null
fi
docker volume create --label ${helperLabel} ${volume} >/dev/null
echo "Downloading and extracting..."
rclone cat ${rcloneFlags(input.destination)} ${remote(input.destination, input.backupFile)} | docker run --rm -i --label ${helperLabel} -v ${quote(`${input.volumeName}:/volume_data`)} ${HELPER_IMAGE} tar -C /volume_data -xf -
echo "Volume restore completed ✅"`;
	await runRclone(host, input.destination, script, {
		onOutput: options.log,
		signal: options.signal,
	});
};
