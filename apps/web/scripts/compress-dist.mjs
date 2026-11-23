// Writes .br and .gz copies of the build's text files; the web server sends
// them to browsers that accept the encoding, so it never compresses at
// request time. index.html is left out: the server fills in its config.
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const root = join(import.meta.dirname, "..", "dist");
const TEXT = /\.(js|mjs|css|svg|json|txt|map)$/;
const MIN_BYTES = 1024;

async function* files(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* files(path);
		else yield path;
	}
}

let count = 0;
for await (const path of files(root)) {
	if (!TEXT.test(path) || (await stat(path)).size < MIN_BYTES) continue;
	const source = await readFile(path);
	const br = brotliCompressSync(source, {
		params: {
			[constants.BROTLI_PARAM_QUALITY]: 11,
			[constants.BROTLI_PARAM_SIZE_HINT]: source.length,
		},
	});
	const gz = gzipSync(source, { level: 9 });
	if (br.length < source.length) await writeFile(`${path}.br`, br);
	if (gz.length < source.length) await writeFile(`${path}.gz`, gz);
	count++;
}
console.log(`compressed ${count} files in ${root}`);
