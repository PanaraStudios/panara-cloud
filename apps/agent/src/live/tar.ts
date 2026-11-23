// Minimal ustar reader/writer for `docker cp` archives: one file or directory
// per archive, names under 100 bytes.

const BLOCK = 512;

export type TarEntry = {
	name: string;
	type: "file" | "directory" | "symlink" | "other";
	size: number;
	mode: number;
	content: Buffer;
};

const writeString = (
	header: Buffer,
	offset: number,
	length: number,
	value: string,
) => {
	header.write(
		value,
		offset,
		Math.min(Buffer.byteLength(value), length),
		"utf8",
	);
};

const writeOctal = (
	header: Buffer,
	offset: number,
	length: number,
	value: number,
) => {
	writeString(
		header,
		offset,
		length,
		`${value.toString(8).padStart(length - 1, "0")}\0`,
	);
};

export const packEntry = (entry: {
	name: string;
	type: "file" | "directory";
	content?: Buffer;
	mode?: number;
	uid?: number;
	gid?: number;
	mtime?: Date;
}): Buffer => {
	const name =
		entry.type === "directory" && !entry.name.endsWith("/")
			? `${entry.name}/`
			: entry.name;
	if (Buffer.byteLength(name) > 99) throw new Error("File name is too long");
	const content =
		entry.type === "file"
			? (entry.content ?? Buffer.alloc(0))
			: Buffer.alloc(0);
	const header = Buffer.alloc(BLOCK);
	writeString(header, 0, 100, name);
	writeOctal(
		header,
		100,
		8,
		entry.mode ?? (entry.type === "directory" ? 0o755 : 0o644),
	);
	writeOctal(header, 108, 8, entry.uid ?? 0);
	writeOctal(header, 116, 8, entry.gid ?? 0);
	writeOctal(header, 124, 12, content.length);
	writeOctal(
		header,
		136,
		12,
		Math.floor((entry.mtime ?? new Date()).getTime() / 1000),
	);
	header.fill(" ", 148, 156);
	header.write(entry.type === "directory" ? "5" : "0", 156, 1, "ascii");
	writeString(header, 257, 6, "ustar\0");
	writeString(header, 263, 2, "00");
	let checksum = 0;
	for (const byte of header) checksum += byte;
	writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
	const padding = (BLOCK - (content.length % BLOCK)) % BLOCK;
	return Buffer.concat([
		header,
		content,
		Buffer.alloc(padding),
		Buffer.alloc(BLOCK * 2),
	]);
};

const readString = (block: Buffer, offset: number, length: number) => {
	const raw = block.subarray(offset, offset + length);
	const end = raw.indexOf(0);
	return raw.subarray(0, end === -1 ? length : end).toString("utf8");
};

const readOctal = (block: Buffer, offset: number, length: number) =>
	Number.parseInt(readString(block, offset, length).trim() || "0", 8);

const TYPES: Record<string, TarEntry["type"]> = {
	"0": "file",
	"\0": "file",
	"": "file",
	"5": "directory",
	"2": "symlink",
};

// Reads the first real entry. `content` may be shorter than `size` when the
// archive was cut off (the caller limits how much it downloads).
export const readFirstEntry = (archive: Buffer): TarEntry | null => {
	let offset = 0;
	let longName: string | null = null;
	while (offset + BLOCK <= archive.length) {
		const header = archive.subarray(offset, offset + BLOCK);
		if (header.every((byte) => byte === 0)) return null;
		const size = readOctal(header, 124, 12);
		const flag = String.fromCharCode(header[156] ?? 0);
		const dataStart = offset + BLOCK;
		const next = dataStart + Math.ceil(size / BLOCK) * BLOCK;
		// GNU long names and pax headers precede the entry they describe.
		if (flag === "L") {
			longName = archive
				.subarray(dataStart, dataStart + size)
				.toString("utf8")
				.replace(/\0+$/, "");
			offset = next;
			continue;
		}
		if (flag === "x" || flag === "g") {
			const pax = archive
				.subarray(dataStart, dataStart + size)
				.toString("utf8");
			const path = /\d+ path=([^\n]*)\n/.exec(pax)?.[1];
			if (path) longName = path;
			offset = next;
			continue;
		}
		const prefix = readString(header, 345, 155);
		const name =
			longName ??
			(prefix
				? `${prefix}/${readString(header, 0, 100)}`
				: readString(header, 0, 100));
		return {
			name,
			type: TYPES[flag] ?? "other",
			size,
			mode: readOctal(header, 100, 8),
			content: archive.subarray(
				dataStart,
				Math.min(dataStart + size, archive.length),
			),
		};
	}
	return null;
};
