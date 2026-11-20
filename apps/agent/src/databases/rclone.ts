import { rcloneFlagError } from "../../../../packages/backend/convex/databases/rcloneFlags";
import type { Host } from "../host/types";
import { quote } from "../lib/shell";
import { exportLine, runHostScript, type ScriptOptions } from "./script";

export type Destination = {
	provider?: string;
	accessKey: string;
	secretAccessKey: string;
	bucket: string;
	region: string;
	endpoint: string;
	additionalFlags: string[];
};

export type RcloneFile = {
	Path: string;
	Name: string;
	Size: number;
	IsDir: boolean;
	ModTime?: string;
};

// Credentials go to rclone through its RCLONE_S3_* environment variables
// rather than --s3-* flags, so they stay out of the host's process list.
// The rest sets region, endpoint, path-style addressing and the optional
// provider, and skips rclone's bucket check.
export const rcloneEnv = (destination: Destination): string =>
	[
		exportLine("RCLONE_S3_ACCESS_KEY_ID", destination.accessKey),
		exportLine("RCLONE_S3_SECRET_ACCESS_KEY", destination.secretAccessKey),
		exportLine("RCLONE_S3_REGION", destination.region),
		exportLine("RCLONE_S3_ENDPOINT", destination.endpoint),
		exportLine("RCLONE_S3_NO_CHECK_BUCKET", "true"),
		exportLine("RCLONE_S3_FORCE_PATH_STYLE", "true"),
		...(destination.provider
			? [exportLine("RCLONE_S3_PROVIDER", destination.provider)]
			: []),
	].join("\n");

export const rcloneFlags = (destination: Destination): string =>
	destination.additionalFlags
		.filter((flag) => rcloneFlagError(flag) === null)
		.join(" ");

export const remote = (destination: Destination, path = "") =>
	quote(`:s3:${destination.bucket}${path ? `/${path}` : ""}`);

export const destinationSecrets = (destination: Destination) => [
	destination.secretAccessKey,
	destination.accessKey,
];

export const runRclone = (
	host: Host,
	destination: Destination,
	script: string,
	options: ScriptOptions = {},
) =>
	runHostScript(host, `${rcloneEnv(destination)}\n${script}`, {
		...options,
		secrets: [...destinationSecrets(destination), ...(options.secrets ?? [])],
	});

export const testConnection = async (
	host: Host,
	destination: Destination,
	options: ScriptOptions = {},
) => {
	await runRclone(
		host,
		destination,
		`rclone lsf --max-depth 1 --retries 1 --low-level-retries 1 --timeout 10s --contimeout 5s ${rcloneFlags(destination)} ${remote(destination)} >/dev/null`,
		options,
	);
};

const parseList = (output: string): RcloneFile[] => {
	const start = output.search(/^\[/m);
	if (start === -1) throw new Error("Could not parse the file list");
	return JSON.parse(output.slice(start)) as RcloneFile[];
};

// Files in `folder` (relative to the bucket), newest first. A missing folder
// is an empty list.
export const listFolder = async (
	host: Host,
	destination: Destination,
	folder: string,
	options: { include?: string; filesOnly?: boolean } & ScriptOptions = {},
): Promise<RcloneFile[]> => {
	const flags = [
		"--no-mimetype",
		"--use-server-modtime",
		...(options.filesOnly ? ["--files-only"] : []),
		...(options.include ? [`--include ${quote(options.include)}`] : []),
	].join(" ");
	const output = await runRclone(
		host,
		destination,
		`out=$(rclone lsjson ${flags} ${rcloneFlags(destination)} ${remote(destination, folder)} 2>&1) || {
  if echo "$out" | grep -qiE 'directory not found|object not found'; then echo '[]'; exit 0; fi
  echo "$out" | tail -n 5; exit 1
}
echo "$out"`,
		{ signal: options.signal },
	);
	const prefix = folder && !folder.endsWith("/") ? `${folder}/` : folder;
	return parseList(output)
		.map((file) => ({ ...file, Path: `${prefix}${file.Path}` }))
		.sort((a, b) => modTime(b) - modTime(a));
};

const modTime = (file: RcloneFile) =>
	file.ModTime ? Date.parse(file.ModTime) || 0 : 0;

// Keep the newest `keep` files, sorted by server modtime because
// custom names break lexical order.
export const filesToPrune = (files: RcloneFile[], keep: number) =>
	keep > 0
		? [...files]
				.filter((file) => !file.IsDir)
				.sort((a, b) => modTime(b) - modTime(a))
				.slice(keep)
		: [];

export const applyRetention = async (
	host: Host,
	destination: Destination,
	folder: string,
	include: string,
	keep: number | undefined,
	options: ScriptOptions = {},
): Promise<string[]> => {
	if (!keep) return [];
	const files = await listFolder(host, destination, folder, {
		include,
		filesOnly: true,
		signal: options.signal,
	});
	const prune = filesToPrune(files, keep);
	if (prune.length === 0) return [];
	await runRclone(
		host,
		destination,
		prune
			.map(
				(file) =>
					`rclone deletefile ${rcloneFlags(destination)} ${remote(destination, file.Path)}`,
			)
			.join("\n"),
		options,
	);
	return prune.map((file) => file.Path);
};

export const backupTimestamp = (date = new Date()) =>
	date.toISOString().replace(/[:.]/g, "-");

export const formatBytes = (bytes: number) => {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
};
