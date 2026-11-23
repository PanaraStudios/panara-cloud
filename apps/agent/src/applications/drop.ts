import { posix } from "node:path";
import AdmZip from "adm-zip";
import type { Host } from "../host/types";
import { quote } from "../lib/shell";
import type { BuildLog } from "./process";

export type DropEntry =
	| { type: "dir"; path: string }
	| { type: "file"; path: string; data: Buffer };

const fileType = (entry: AdmZip.IZipEntry) =>
	(entry.header.attr >> 16) & 0o170000;

const DANGEROUS = new Set([
	0o120000, // symlink
	0o060000, // block device
	0o020000, // char device
	0o010000, // fifo
]);

// The whole drop is inflated and base64-encoded in the shared agent's memory
// (V8 strings top out near 512M characters), so a zip bomb must be refused
// before anything is inflated.
export const MAX_DROP_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
export const MAX_DROP_ENTRIES = 20_000;

const tooLarge = () =>
	new Error(
		`The zip is too large once extracted (limit ${MAX_DROP_UNCOMPRESSED_BYTES / 1024 / 1024} MB)`,
	);

// Plans the extraction of an uploaded zip: drops __MACOSX, strips a single top-level folder, and
// rejects path traversal and symlinks/devices.
export const planDrop = (zip: Buffer): DropEntry[] => {
	const all = new AdmZip(zip).getEntries();
	if (all.length > MAX_DROP_ENTRIES) {
		throw new Error(
			`The zip has too many entries (${all.length}, limit ${MAX_DROP_ENTRIES})`,
		);
	}
	const entries = all.filter(
		(entry) => !entry.entryName.startsWith("__MACOSX"),
	);
	// adm-zip caps inflation at each entry's declared size, so bounding the
	// declared total bounds what getData() can allocate.
	const declared = entries.reduce((sum, entry) => sum + entry.header.size, 0);
	if (declared > MAX_DROP_UNCOMPRESSED_BYTES) throw tooLarge();
	let inflated = 0;
	const roots = entries.filter((entry) => {
		const parts = entry.entryName.split("/");
		return (
			parts.length === 1 ||
			(parts.length === 2 && entry.entryName.endsWith("/"))
		);
	});
	const rootFolder =
		roots.length === 1 && roots[0]?.isDirectory
			? (roots[0].entryName.split("/")[0] ?? "")
			: "";
	const result: DropEntry[] = [];
	for (const entry of entries) {
		if (DANGEROUS.has(fileType(entry))) {
			throw new Error(
				`Dangerous node entries are not allowed: ${entry.entryName}`,
			);
		}
		let path = entry.entryName.replace(/\\/g, "/");
		if (rootFolder && path.startsWith(`${rootFolder}/`)) {
			path = path.slice(rootFolder.length + 1);
		}
		path = path.replace(/\/+$/, "");
		if (!path) continue;
		const normalized = posix.normalize(path);
		if (
			normalized.startsWith("/") ||
			normalized === ".." ||
			normalized.startsWith("../") ||
			/[\0\r\n]/.test(normalized)
		) {
			throw new Error(
				`Path traversal detected: resolved path escapes output directory: ${entry.entryName}`,
			);
		}
		if (entry.isDirectory) {
			result.push({ type: "dir", path: normalized });
			continue;
		}
		const data = entry.getData();
		inflated += data.length;
		if (inflated > MAX_DROP_UNCOMPRESSED_BYTES) throw tooLarge();
		result.push({ type: "file", path: normalized, data });
	}
	return result;
};

// One `<kind> <base64 path>` line plus one base64 content line per entry,
// written by a small loop on the host (works over SSH without SFTP).
export const dropStream = (entries: DropEntry[]) =>
	entries
		.map((entry) =>
			entry.type === "dir"
				? `d ${Buffer.from(entry.path).toString("base64")}\n\n`
				: `f ${Buffer.from(entry.path).toString("base64")}\n${entry.data.toString("base64")}\n`,
		)
		.join("");

export const extractDrop = async (
	host: Host,
	zip: Buffer,
	dest: string,
	log: BuildLog,
	signal?: AbortSignal,
) => {
	const entries = planDrop(zip);
	log.line(
		`Extracting ${entries.filter((e) => e.type === "file").length} file(s) to ${dest}`,
	);
	const script = [
		"set -e",
		`dest=${quote(dest)}`,
		'rm -rf -- "$dest"',
		'mkdir -p -- "$dest"',
		'while IFS=" " read -r kind name && IFS= read -r data; do',
		'  path="$dest/$(printf %s "$name" | base64 -d)"',
		'  if [ "$kind" = d ]; then mkdir -p -- "$path"; continue; fi',
		'  mkdir -p -- "$(dirname -- "$path")"',
		'  printf %s "$data" | base64 -d > "$path"',
		"done",
	].join("\n");
	const result = await host.exec(script, {
		input: dropStream(entries),
		signal,
	});
	if (result.code !== 0) {
		throw new Error(
			`Extracting the zip failed: ${result.output.trim().slice(-500)}`,
		);
	}
};

export const downloadDrop = async (url: string, signal?: AbortSignal) => {
	const response = await fetch(url, { signal });
	if (!response.ok) {
		throw new Error(`Downloading the zip failed (HTTP ${response.status})`);
	}
	return Buffer.from(await response.arrayBuffer());
};
