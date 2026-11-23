import { posix } from "node:path";
import { quote } from "../lib/shell";
import type { LiveConnection } from "./connection";
import { assertContainerAccess, assertVolumeAccess } from "./ownership";
import type { RequestOf } from "./protocol";
import {
	errorMessage,
	type SessionContext,
	type SessionHandler,
} from "./session";
import { packEntry, readFirstEntry } from "./tar";

export const MAX_READ_BYTES = 1024 * 1024;
// Files too large to read whole open as a truncated preview of this size
// instead of failing.
export const PREVIEW_BYTES = 512 * 1024;
export const MAX_WRITE_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const HELPER_IMAGE = process.env.LIVE_FILES_HELPER_IMAGE ?? "alpine:3.20";

export type FileEntry = {
	name: string;
	type: "file" | "directory" | "symlink" | "other";
	size: number | null;
	mode: string | null;
	modifiedAt: string | null;
};

export class FileError extends Error {}

export const normalizePath = (value: unknown): string => {
	if (
		typeof value !== "string" ||
		!value.startsWith("/") ||
		value.length > 4096 ||
		value.includes("\0")
	) {
		throw new FileError("Path must be an absolute path");
	}
	return posix.normalize(value);
};

// `stat` exists in GNU coreutils and busybox; `ls` is the last resort.
const LIST_SCRIPT = [
	'd=$1; [ -d "$d" ] || { echo "Not a directory: $d" >&2; exit 2; }',
	`if command -v stat >/dev/null 2>&1; then find "$d" -mindepth 1 -maxdepth 1 -exec stat -c '%F\t%s\t%Y\t%a\t%n' {} + 2>/dev/null | head -n ${MAX_ENTRIES}; else echo __LS__; ls -1Ap "$d" | head -n ${MAX_ENTRIES}; fi`,
].join("\n");

const statType = (value: string): FileEntry["type"] => {
	if (value.includes("directory")) return "directory";
	if (value.includes("symbolic link")) return "symlink";
	if (value.includes("regular")) return "file";
	return "other";
};

const sortEntries = (a: FileEntry, b: FileEntry) =>
	a.type === b.type
		? a.name.localeCompare(b.name)
		: a.type === "directory"
			? -1
			: b.type === "directory"
				? 1
				: a.name.localeCompare(b.name);

export const parseListing = (stdout: string): FileEntry[] => {
	const lines = stdout.split("\n").filter(Boolean);
	if (lines[0] === "__LS__") {
		return lines
			.slice(1)
			.map((line) => ({
				name: line.endsWith("/") ? line.slice(0, -1) : line,
				type: (line.endsWith("/") ? "directory" : "file") as FileEntry["type"],
				size: null,
				mode: null,
				modifiedAt: null,
			}))
			.sort(sortEntries);
	}
	return lines
		.flatMap((line) => {
			const [type, size, mtime, mode, ...rest] = line.split("\t");
			const path = rest.join("\t");
			if (!type || !path) return [];
			const seconds = Number(mtime);
			return [
				{
					name: posix.basename(path),
					type: statType(type),
					size: Number.isFinite(Number(size)) ? Number(size) : null,
					mode: mode || null,
					modifiedAt: Number.isFinite(seconds)
						? new Date(seconds * 1000).toISOString()
						: null,
				},
			];
		})
		.sort(sortEntries);
};

export const encodeContent = (content: Buffer) => {
	const text = content.toString("utf8");
	return !content.includes(0) && Buffer.from(text, "utf8").equals(content)
		? { encoding: "utf8" as const, content: text }
		: { encoding: "base64" as const, content: content.toString("base64") };
};

const fail = (stderr: string, fallback: string): never => {
	throw new FileError(
		stderr.trim().split("\n").at(-1)?.slice(0, 300) || fallback,
	);
};

export const listContainerDir = async (
	conn: LiveConnection,
	containerId: string,
	path: string,
	user?: string,
) => {
	const result = await conn.run(
		`docker exec ${user ? `-u ${quote(user)} ` : ""}${quote(containerId)} sh -c ${quote(LIST_SCRIPT)} sh ${quote(path)}`,
	);
	if (result.code !== 0)
		fail(result.stderr || result.stdout, "Unable to list files");
	return { path, entries: parseListing(result.stdout) };
};

export type ReadOptions = { maxBytes?: number; truncate?: boolean };

const readResult = (
	path: string,
	size: number,
	content: Buffer,
	{ maxBytes = MAX_READ_BYTES, truncate = false }: ReadOptions,
) => {
	if (size > maxBytes && !truncate) {
		throw new FileError(`File exceeds the ${maxBytes} byte limit`);
	}
	return {
		path,
		size,
		truncated: size > maxBytes,
		...encodeContent(content.subarray(0, maxBytes)),
	};
};

// Reads through `docker cp`, which also works on images without a shell.
export const readContainerFile = async (
	conn: LiveConnection,
	containerId: string,
	path: string,
	options: ReadOptions = {},
) => {
	const maxBytes = options.maxBytes ?? MAX_READ_BYTES;
	const result = await conn.run(
		`docker cp -L ${quote(`${containerId}:${path}`)} - | head -c ${maxBytes + 64 * 1024} | base64 | tr -d '\\n'`,
	);
	const archive = Buffer.from(result.stdout.trim(), "base64");
	const entry = archive.length ? readFirstEntry(archive) : null;
	if (!entry) fail(result.stderr, "File not found");
	const file = entry as NonNullable<typeof entry>;
	if (file.type !== "file") throw new FileError("Path is not a regular file");
	return readResult(path, file.size, file.content, options);
};

const volumeCommand = (
	volume: string,
	script: string,
	args: string[],
	writable = false,
) =>
	[
		`docker run --rm${writable ? " -i" : ""} --network none --label panara-cloud.managed=true`,
		`-v ${quote(`${volume}:/v${writable ? "" : ":ro"}`)}`,
		`--entrypoint sh ${quote(HELPER_IMAGE)}`,
		`-c ${quote(script)} sh`,
		...args.map(quote),
	].join(" ");

export const listVolumeDir = async (
	conn: LiveConnection,
	volume: string,
	path: string,
) => {
	const result = await conn.run(
		volumeCommand(volume, LIST_SCRIPT, [`/v${path}`]),
	);
	if (result.code !== 0) fail(result.stderr, "Unable to list files");
	return { path, entries: parseListing(result.stdout) };
};

const READ_SCRIPT = [
	'f=$1; [ -f "$f" ] || { echo "Path is not a regular file" >&2; exit 3; }',
	'stat -c %s "$f"; head -c "$2" "$f" | base64 | tr -d "\\n"',
].join("\n");

export const readVolumeFile = async (
	conn: LiveConnection,
	volume: string,
	path: string,
	options: ReadOptions = {},
) => {
	const maxBytes = options.maxBytes ?? MAX_READ_BYTES;
	const result = await conn.run(
		volumeCommand(volume, READ_SCRIPT, [`/v${path}`, String(maxBytes)]),
	);
	if (result.code !== 0) fail(result.stderr, "Unable to read file");
	const newline = result.stdout.indexOf("\n");
	const size = Number(result.stdout.slice(0, newline));
	const content = Buffer.from(
		result.stdout.slice(newline + 1).trim(),
		"base64",
	);
	return readResult(path, size, content, options);
};

const fileName = (path: string) => {
	const name = posix.basename(path);
	if (path === "/" || !name) throw new FileError("Path must point to a file");
	return name;
};

export const decodeWriteContent = (content: unknown, encoding: unknown) => {
	if (typeof content !== "string") {
		throw new FileError("content must be a string");
	}
	const buffer =
		encoding === "base64"
			? Buffer.from(content, "base64")
			: Buffer.from(content, "utf8");
	if (buffer.length > MAX_WRITE_BYTES) {
		throw new FileError(`File exceeds the ${MAX_WRITE_BYTES} byte limit`);
	}
	return buffer;
};

// Through `docker cp`, so images without a shell can be written too.
export const writeContainerFile = async (
	conn: LiveConnection,
	containerId: string,
	path: string,
	content: Buffer,
) => {
	const tar = packEntry({ name: fileName(path), type: "file", content });
	const result = await conn.run(
		`base64 -d | docker cp - ${quote(`${containerId}:${posix.dirname(path)}`)}`,
		{ input: tar.toString("base64") },
	);
	if (result.code !== 0) fail(result.stderr || result.stdout, "Write failed");
	return { path, size: content.length };
};

export const deleteContainerPath = async (
	conn: LiveConnection,
	containerId: string,
	path: string,
) => {
	fileName(path);
	const result = await conn.run(
		`docker exec ${quote(containerId)} rm -rf -- ${quote(path)}`,
	);
	if (result.code !== 0) fail(result.stderr || result.stdout, "Delete failed");
	return { path };
};

const VOLUME_WRITE_SCRIPT = 'mkdir -p "$(dirname "$1")" && base64 -d > "$1"';

export const writeVolumeFile = async (
	conn: LiveConnection,
	volume: string,
	path: string,
	content: Buffer,
) => {
	fileName(path);
	const result = await conn.run(
		volumeCommand(volume, VOLUME_WRITE_SCRIPT, [`/v${path}`], true),
		{ input: content.toString("base64") },
	);
	if (result.code !== 0) fail(result.stderr, "Write failed");
	return { path, size: content.length };
};

export const deleteVolumePath = async (
	conn: LiveConnection,
	volume: string,
	path: string,
) => {
	fileName(path);
	const result = await conn.run(
		volumeCommand(volume, 'rm -rf -- "$1"', [`/v${path}`], true),
	);
	if (result.code !== 0) fail(result.stderr, "Delete failed");
	return { path };
};

// Browsing of a container's or a volume's files. Changes (write, delete)
// need an unrestricted session: an admin of the host.
export const startFiles = async (
	ctx: SessionContext,
): Promise<SessionHandler> => {
	const request = ctx.redeemed.request as RequestOf<"files">;
	const { target } = request;
	const containerId =
		target.type === "container"
			? await assertContainerAccess(
					ctx.conn,
					target.containerId,
					ctx.redeemed.restriction,
				)
			: null;
	if (target.type === "volume") {
		await assertVolumeAccess(
			ctx.conn,
			target.volumeName,
			ctx.redeemed.restriction,
		);
	}
	let queue = Promise.resolve();
	return {
		onMessage: (message) => {
			if (message.type !== "request") return;
			queue = queue.then(async () => {
				try {
					const path = normalizePath(message.payload.path ?? "/");
					let data: unknown;
					if (message.op === "list") {
						data = containerId
							? await listContainerDir(ctx.conn, containerId, path)
							: await listVolumeDir(
									ctx.conn,
									(target as { volumeName: string }).volumeName,
									path,
								);
					} else if (message.op === "read") {
						const options: ReadOptions =
							message.payload.preview === true
								? { maxBytes: PREVIEW_BYTES, truncate: true }
								: {};
						data = containerId
							? await readContainerFile(ctx.conn, containerId, path, options)
							: await readVolumeFile(
									ctx.conn,
									(target as { volumeName: string }).volumeName,
									path,
									options,
								);
					} else if (message.op === "write" || message.op === "delete") {
						if (ctx.redeemed.restriction) {
							throw new FileError("Changing files requires an administrator");
						}
						const volumeName = (target as { volumeName: string }).volumeName;
						if (message.op === "write") {
							const content = decodeWriteContent(
								message.payload.content,
								message.payload.encoding,
							);
							data = containerId
								? await writeContainerFile(ctx.conn, containerId, path, content)
								: await writeVolumeFile(ctx.conn, volumeName, path, content);
						} else {
							data = containerId
								? await deleteContainerPath(ctx.conn, containerId, path)
								: await deleteVolumePath(ctx.conn, volumeName, path);
						}
					} else {
						throw new FileError(`Unknown operation: ${message.op}`);
					}
					ctx.send({ type: "result", id: message.id, ok: true, data });
				} catch (error) {
					ctx.send({
						type: "result",
						id: message.id,
						ok: false,
						error: errorMessage(error),
					});
				}
			});
		},
	};
};
