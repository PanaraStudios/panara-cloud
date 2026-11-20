// Panel backups: the panel host's own config, data and secrets.
//
// Archive `panara-cloud-panel/<prefix>/panel-backup-<timestamp>.tar.gz` in the
// destination bucket holds:
//   panara-cloud/                /etc/panara-cloud: Traefik config, dynamic routes,
//                          certificates, acme.json, compose/application files
//                          (minus .git, secrets, volume-backups, patch-repos, logs and
//                          earlier restores)
//   convex-snapshot.zip    `convex export --include-file-storage` of the
//                          panel's Convex deployment, when available
//   panel-secrets.b64env   NAME=<base64 value> per line: SECRETS_KEY,
//                          BETTER_AUTH_SECRET, AGENT_JWT_*, AGENT_JWKS,
//                          RESEND_API_KEY, when the backup includes them
//                          (the "include encryption key" option), so a new
//                          panel can use the snapshot. Values are base64
//                          because the JWT keys span several lines. Archives
//                          from before held only encryption-key.env
//                          (SECRETS_KEY=...).
//
// The snapshot needs the deployment's admin key, which never goes into
// Convex. Give it to the agent on the panel host as PANARA_CLOUD_CONVEX_ADMIN_KEY or
// as a file path in PANARA_CLOUD_CONVEX_ADMIN_KEY_FILE (mode 0600). The backend URL
// is PANARA_CLOUD_CONVEX_SELF_HOSTED_URL, else CONVEX_URL. Without a key, or when
// the job's host is not the agent's own machine, only /etc/panara-cloud is archived
// and the job log says so.
//
// Restore (job `databases.panelRestore`, then by hand):
//   1. The job downloads the archive, copies `panara-cloud/` over /etc/panara-cloud (no
//      wipe; modes kept, acme.json stays 0600), restarts Traefik and leaves
//      the snapshot at /etc/panara-cloud/panel-restore/<timestamp>/convex-snapshot.zip
//      (root, 0600).
//   2. Import the snapshot from any machine with the convex CLI:
//        CONVEX_SELF_HOSTED_URL=<backend url> CONVEX_SELF_HOSTED_ADMIN_KEY=<key> \
//          npx convex import --replace-all -y convex-snapshot.zip
//      It replaces every table, including jobs, so it can't run inside a job.
//      The backend must use the same secrets as when the backup was taken.
//      When the backup included them they are staged as
//      panel-restore/<timestamp>/panel-secrets.b64env and the job log prints
//      the command that sets them (secretsRestoreCommand).
//      Agent enrollments, memberships and jobs revert to the snapshot.
//   3. Scheduled functions are not in snapshots; the reconcile crons re-arm
//      backup and schedule timers within ten minutes.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import type { Host } from "../host/types";
import { paths } from "../lib/constants";
import { quote } from "../lib/shell";
import { redact } from "../sources/redact";
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

export const PANEL_BACKUP_INCLUDE = "panel-backup-*.tar.gz";
export const SNAPSHOT_FILE = "convex-snapshot.zip";
export const SECRETS_FILE = "panel-secrets.b64env";
const LEGACY_KEY_FILE = "encryption-key.env";

const SUDO = `SUDO=""; if [ "$(id -u)" -ne 0 ]; then SUDO="sudo -n"; fi`;

// secrets/ holds the installer's host-bound credentials (Convex admin key,
// agent enrollment secret); a restored panel gets its own.
const EXCLUDED = [
	"secrets",
	"volume-backups",
	"patch-repos",
	"panel-restore",
	"logs",
	"applications/*/code/.git",
	"compose/*/code/.git",
];

type Options = { log: (text: string) => void; signal?: AbortSignal };

export type PanelBackupInput = {
	folder: string;
	keepLatestCount?: number;
	destination: Destination;
	basePath?: string;
	// Path on the host of a snapshot zip to include.
	convexSnapshot?: string | null;
	// Deployment env vars, when the backup includes them.
	secrets?: { name: string; value: string }[];
};

export type PanelRestoreInput = {
	backupFile: string;
	destination: Destination;
	basePath?: string;
};

export const panelBackupFile = (folder: string, date = new Date()) =>
	`${folder}panel-backup-${backupTimestamp(date)}.tar.gz`;

const splitBase = (basePath: string) => {
	const base = posix.normalize(basePath).replace(/\/+$/, "");
	const name = posix.basename(base);
	if (!base.startsWith("/") || !name || name === "..") {
		throw new Error(`Invalid base path: ${basePath}`);
	}
	return { base, parent: posix.dirname(base), name };
};

// GNU tar exits 1 when a file changes while it is read (Traefik rewrites
// acme.json and dynamic files at any time); the archive is still usable.
export const archiveCommand = (
	basePath: string,
	...extraFiles: (string | null | undefined)[]
) => {
	const { parent, name } = splitBase(basePath);
	const excludes = EXCLUDED.map(
		(pattern) => `--exclude=${quote(`${name}/${pattern}`)}`,
	).join(" ");
	const extras = extraFiles
		.filter((file): file is string => !!file)
		.map(
			(file) =>
				` -C ${quote(posix.dirname(file))} ${quote(posix.basename(file))}`,
		)
		.join("");
	return `( $SUDO tar -czf - ${excludes} -C ${quote(parent)} ${quote(name)}${extras}; s=$?; [ $s -le 1 ] )`;
};

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

export const secretsContent = (secrets: { name: string; value: string }[]) =>
	secrets
		.map(({ name, value }) => {
			if (!ENV_NAME.test(name)) throw new Error(`Invalid env name: ${name}`);
			return `${name}=${Buffer.from(value).toString("base64")}\n`;
		})
		.join("");

export const secretsRestoreCommand = (file: string) =>
	`while IFS='=' read -r name value; do printf '%s' "$value" | base64 -d | CONVEX_SELF_HOSTED_URL=<backend url> CONVEX_SELF_HOSTED_ADMIN_KEY=<admin key> npx convex env set "$name"; done < ${quote(file)}`;

// Writes the secrets through stdin into a private temp directory on the
// host, so they never appear in a command line or the job log.
const stageSecrets = async (
	host: Host,
	secrets: { name: string; value: string }[],
) => {
	const dir = (
		await host.run(
			`umask 077 && d=$(mktemp -d) && cat > "$d/${SECRETS_FILE}" && echo "$d"`,
			{ input: secretsContent(secrets) },
		)
	).trim();
	return { dir, file: `${dir}/${SECRETS_FILE}` };
};

export const runPanelBackup = async (
	host: Host,
	input: PanelBackupInput,
	options: Options & { now?: Date },
): Promise<{ file: string; size?: string; pruned: string[] }> => {
	const { base } = splitBase(input.basePath ?? paths.base);
	const file = panelBackupFile(input.folder, options.now);
	const target = remote(input.destination, file);
	const flags = rcloneFlags(input.destination);
	const secrets = input.secrets ?? [];
	const key = secrets.length ? await stageSecrets(host, secrets) : null;
	const parts = [
		base,
		input.convexSnapshot ? "the Convex snapshot" : null,
		key
			? `the deployment secrets (${secrets.map((s) => s.name).join(", ")})`
			: null,
	].filter(Boolean);
	const script = `${SUDO}
[ -d ${quote(base)} ] || { echo ${quote(`❌ Error: ${base} not found`)}; exit 1; }
echo ${quote(`Archiving ${parts.join(", ")}`)}
echo ${quote(`Uploading to ${file}`)}
if ! { ${archiveCommand(base, input.convexSnapshot, key?.file)} | rclone rcat ${flags} ${target}; }; then
	rclone deletefile ${flags} ${target} >/dev/null 2>&1 || true
	echo "❌ Error: Panel backup failed"
	exit 1
fi
echo "Panel backup uploaded ✅"`;
	try {
		await runRclone(host, input.destination, script, {
			onOutput: options.log,
			signal: options.signal,
			secrets: secrets.flatMap(({ value }) => [
				value,
				Buffer.from(value).toString("base64"),
			]),
		});
	} finally {
		if (key) await host.exec(`rm -rf ${quote(key.dir)}`).catch(() => {});
	}
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
		PANEL_BACKUP_INCLUDE,
		input.keepLatestCount,
		{ signal: options.signal },
	);
	for (const path of pruned) options.log(`Removed old backup ${path}\n`);
	return { file, size, pruned };
};

export const restoreDir = (basePath: string, date = new Date()) =>
	`${splitBase(basePath).base}/panel-restore/${backupTimestamp(date)}`;

export const convexImportCommand = (snapshotPath: string) =>
	`CONVEX_SELF_HOSTED_URL=<backend url> CONVEX_SELF_HOSTED_ADMIN_KEY=<admin key> npx convex import --replace-all -y ${quote(snapshotPath)}`;

// Copies the archived panel directory over the base path (files deleted
// since the backup are kept) and stages the Convex snapshot for a manual
// import. Returns the snapshot's path, if the archive had one.
export const restorePanelBackup = async (
	host: Host,
	input: PanelRestoreInput,
	options: Options & { now?: Date },
): Promise<{ convexSnapshot: string | null; secrets: string | null }> => {
	const { base } = splitBase(input.basePath ?? paths.base);
	const stage = restoreDir(base, options.now);
	const snapshot = `${stage}/${SNAPSHOT_FILE}`;
	const secretsFile = `${stage}/${SECRETS_FILE}`;
	const legacyKeyFile = `${stage}/${LEGACY_KEY_FILE}`;
	const script = `${SUDO}
STAGE=${quote(stage)}
$SUDO mkdir -p "$STAGE"
$SUDO chmod 700 "$STAGE"
echo ${quote(`Downloading ${input.backupFile}`)}
rclone cat ${rcloneFlags(input.destination)} ${remote(input.destination, input.backupFile)} | $SUDO tar -xzf - -C "$STAGE"
SRC=$($SUDO find "$STAGE" -mindepth 1 -maxdepth 1 -type d | head -n 1)
[ -n "$SRC" ] || { echo "❌ Error: the archive has no panel directory"; exit 1; }
echo ${quote(`Restoring files into ${base}`)}
$SUDO mkdir -p ${quote(base)}
$SUDO cp -a "$SRC/." ${quote(`${base}/`)}
$SUDO rm -rf "$SRC"
if $SUDO test -f ${quote(snapshot)}; then
	$SUDO chmod 600 ${quote(snapshot)}
	echo "SNAPSHOT=yes"
fi
if $SUDO test -f ${quote(secretsFile)}; then
	$SUDO chmod 600 ${quote(secretsFile)}
	echo "SECRETS=yes"
elif $SUDO test -f ${quote(legacyKeyFile)}; then
	$SUDO chmod 600 ${quote(legacyKeyFile)}
	echo "LEGACY_KEY=yes"
fi
echo "Files restored ✅"`;
	const output = await runRclone(host, input.destination, script, {
		onOutput: options.log,
		signal: options.signal,
	});
	const hasSnapshot = output.includes("SNAPSHOT=yes");
	if (hasSnapshot) {
		options.log(
			`Convex snapshot staged at ${snapshot}. Import it with:\n  ${convexImportCommand(snapshot)}\n`,
		);
	} else {
		options.log(
			"The archive has no Convex snapshot; only files were restored\n",
		);
	}
	let secrets: string | null = null;
	if (output.includes("SECRETS=yes")) {
		secrets = secretsFile;
		options.log(
			`Deployment secrets staged at ${secretsFile} (root, 0600). Set them on the backend before importing the snapshot (as root):\n  ${secretsRestoreCommand(secretsFile)}\n`,
		);
	} else if (output.includes("LEGACY_KEY=yes")) {
		secrets = legacyKeyFile;
		options.log(
			`Encryption key staged at ${legacyKeyFile} (root, 0600). Set it on the backend as SECRETS_KEY before importing the snapshot; BETTER_AUTH_SECRET and the AGENT_JWT_* keys must be copied from the old backend by hand\n`,
		);
	}
	return { convexSnapshot: hasSnapshot ? snapshot : null, secrets };
};

type Env = Record<string, string | undefined>;

export const convexAdminKey = async (env: Env = process.env) => {
	const inline = env.PANARA_CLOUD_CONVEX_ADMIN_KEY?.trim();
	if (inline) return inline;
	const file = env.PANARA_CLOUD_CONVEX_ADMIN_KEY_FILE?.trim();
	if (!file) return null;
	return (await readFile(file, "utf8")).trim() || null;
};

const convexCli = () =>
	join(
		dirname(createRequire(import.meta.url).resolve("convex/package.json")),
		"bin",
		"main.js",
	);

// Runs `convex export` with the CLI bundled with the agent. The CLI only runs
// from a directory whose package.json depends on convex, so it gets a private
// scratch directory; the zip lands in `destDir` on the agent's filesystem.
export const exportConvexSnapshot = async (
	destDir: string,
	options: Options & { env?: Env },
): Promise<string> => {
	const env = options.env ?? process.env;
	const url = env.PANARA_CLOUD_CONVEX_SELF_HOSTED_URL?.trim() || env.CONVEX_URL;
	const key = await convexAdminKey(env);
	if (!url || !key) throw new Error("No Convex URL or admin key configured");
	const cwd = await mkdtemp(join(tmpdir(), "panara-cloud-convex-export-"));
	const output = join(destDir, SNAPSHOT_FILE);
	try {
		await writeFile(
			join(cwd, "package.json"),
			JSON.stringify({ private: true, dependencies: { convex: "*" } }),
		);
		const childEnv: Env = { ...env };
		for (const name of [
			"CONVEX_DEPLOYMENT",
			"CONVEX_DEPLOY_KEY",
			"PANARA_CLOUD_CONVEX_ADMIN_KEY",
		]) {
			delete childEnv[name];
		}
		await new Promise<void>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[convexCli(), "export", "--path", output, "--include-file-storage"],
				{
					cwd,
					env: {
						...childEnv,
						CONVEX_SELF_HOSTED_URL: url,
						CONVEX_SELF_HOSTED_ADMIN_KEY: key,
					},
					signal: options.signal,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let tail = "";
			const collect = (data: Buffer) => {
				const text = redact(data.toString("utf8"), [key]);
				tail = (tail + text).slice(-2000);
				options.log(text);
			};
			child.stdout.on("data", collect);
			child.stderr.on("data", collect);
			child.on("error", reject);
			child.on("close", (code) =>
				code === 0
					? resolve()
					: reject(
							new Error(
								`convex export exited with code ${code}: ${tail.trim().split("\n").at(-1) ?? ""}`,
							),
						),
			);
		});
		return output;
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
};
