import { posix } from "node:path";
import { parse } from "yaml";
import { BASE_PATH } from "../lib/constants";
import { parseEnv } from "../lib/env";

// The files `docker compose config` reads while it loads a compose file:
// `include` paths (with their env files, and the `.env` an include's
// project directory supplies by default), `extends.file` and `label_file`,
// followed through every file they pull in. A trusted job copies them from
// the commit or the panel into its state folder and resolves the copies, so
// nothing a container can change in the service's folder reaches the
// snapshot. Relative paths resolve against the file's working directory (the
// project directory, an include's project directory, or an extended file's
// folder), as docker compose resolves them; the file's own folder is checked
// too, so a path is never followed out of the service's folder either way.

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

const asList = (value: unknown): unknown[] =>
	Array.isArray(value)
		? value
		: value === undefined || value === null
			? []
			: [value];

const within = (path: string, folder: string) =>
	path === folder || path.startsWith(`${folder}/`);

export class SourceFileError extends Error {}

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const BRACED = new RegExp(`^\\{(${NAME})(?:(:?[-?+])(.*))?\\}$`, "s");

// docker compose's interpolation of a path, from the variables that are
// known for certain. A variable without a value or default, or a nested
// expression, can't be checked and is refused.
export const interpolatePath = (
	value: string,
	env: Record<string, string>,
): string => {
	const fail = () =>
		new SourceFileError(
			`${value} uses a variable this deploy cannot check; write the path out or set the variable in the service's environment`,
		);
	let out = "";
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (char !== "$") {
			out += char;
			continue;
		}
		const next = value[i + 1];
		if (next === "$") {
			out += "$";
			i++;
			continue;
		}
		if (next === "{") {
			const end = value.indexOf("}", i);
			if (end === -1) throw fail();
			const match = BRACED.exec(value.slice(i + 1, end + 1));
			if (!match) throw fail();
			const [, name = "", op, word = ""] = match;
			if (word.includes("$")) throw fail();
			const set = Object.hasOwn(env, name);
			const current = set ? (env[name] ?? "") : "";
			const empty = current === "";
			let result: string;
			if (op === ":-") result = empty ? word : current;
			else if (op === "-") result = set ? current : word;
			else if (op === ":+") result = empty ? "" : word;
			else if (op === "+") result = set ? word : "";
			else if (op === ":?" || op === "?") {
				if (op === ":?" ? empty : !set) throw fail();
				result = current;
			} else {
				if (!set) throw fail();
				result = current;
			}
			out += result;
			i = end;
			continue;
		}
		const name = new RegExp(`^${NAME}`).exec(value.slice(i + 1))?.[0];
		if (!name) {
			out += "$";
			continue;
		}
		if (!Object.hasOwn(env, name)) throw fail();
		out += env[name] ?? "";
		i += name.length;
	}
	return out;
};

const isRemote = (path: string) =>
	/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path) ||
	path.startsWith("git@") ||
	path.startsWith("git::");

// Reads a file by its path relative to the service's folder ("code/x.yml",
// "files/y"): null when there is no such file, an error when the path may
// not be read at all.
export type FileLookup = (path: string) => Promise<string | null>;

export type CollectOptions = {
	// The service's folder.
	base: string;
	// The compose file docker compose is given, relative to `base`, and its
	// content (the rendered file, for a deploy).
	composeFile: string;
	text: string;
	// The project directory, relative to `base`.
	projectDir: string;
	// The variables docker compose interpolates the compose file with.
	env: Record<string, string>;
	lookup: FileLookup;
	// Lenient collection (a capture at clone time) skips what it can't
	// follow; a deploy refuses it.
	strict: boolean;
};

type Pending = {
	file: string;
	text: string;
	dir: string | null;
	env: Record<string, string>;
};

const MAX_FILES = 200;

// Every file the load reads that lies in the service's folder, by path
// relative to it (the compose file itself excluded). Remote includes and
// absolute paths outside Panara Cloud's folders are the administrator's
// own and left to docker compose.
export const collectSourceFiles = async (
	options: CollectOptions,
): Promise<Map<string, string>> => {
	const { base, lookup, strict } = options;
	const found = new Map<string, string>();
	const seen = new Set<string>();
	const queue: Pending[] = [
		{
			file: options.composeFile,
			text: options.text,
			dir: options.projectDir,
			env: options.env,
		},
	];

	const attempt = async (work: () => Promise<void>) => {
		try {
			await work();
		} catch (error) {
			if (strict) throw error;
		}
	};

	// A path relative to `base`, or null for one docker compose may read
	// where it is (remote, or a host file outside Panara Cloud's folders).
	const resolve = (raw: unknown, from: Pending, what: string) => {
		if (typeof raw !== "string" || !raw) {
			throw new SourceFileError(`${what} in ${from.file} is not a path`);
		}
		const value = interpolatePath(raw, from.env);
		if (isRemote(value)) return null;
		if (posix.isAbsolute(value)) {
			const absolute = posix.normalize(value);
			if (within(absolute, BASE_PATH)) {
				throw new SourceFileError(
					`${what} ${value} (in ${from.file}) is in Panara Cloud's folders, which containers can change; refer to it relative to the compose file`,
				);
			}
			return null;
		}
		if (from.dir === null) return null;
		const candidates = [
			posix.resolve(base, from.dir, value),
			posix.resolve(base, posix.dirname(from.file), value),
		];
		for (const candidate of candidates) {
			if (!within(candidate, base) || candidate === base) {
				throw new SourceFileError(
					`${what} ${value} (in ${from.file}) leaves the service's folder; give a file outside it as an absolute path`,
				);
			}
		}
		return candidates.map((candidate) => posix.relative(base, candidate));
	};

	// The first path is the one docker compose reads; the other candidate
	// is copied too when it exists.
	const read = async (paths: string[], what: string, required = true) => {
		const [primary = "", ...others] = [...new Set(paths)];
		let text = found.get(primary) ?? null;
		if (text === null) {
			text = await lookup(primary);
			if (text !== null) found.set(primary, text);
		}
		for (const other of others) {
			if (found.has(other)) continue;
			const content = await lookup(other).catch(() => null);
			if (content !== null) found.set(other, content);
		}
		if (text === null && required) {
			throw new SourceFileError(
				`${what} ${primary} was not found in this deploy's source`,
			);
		}
		return text;
	};

	while (queue.length) {
		const item = queue.shift() as Pending;
		const key = `${item.file}\0${item.dir}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (seen.size > MAX_FILES) {
			throw new SourceFileError("The compose file pulls in too many files");
		}
		let model: unknown;
		try {
			model = parse(item.text, { maxAliasCount: 10000, merge: true });
		} catch (error) {
			if (!strict) continue;
			throw new SourceFileError(
				`${item.file} could not be read: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!isRecord(model)) continue;

		for (const entry of asList(model.include)) {
			await attempt(async () => {
				const spec = typeof entry === "string" ? { path: entry } : entry;
				if (!isRecord(spec)) {
					throw new SourceFileError(`An include in ${item.file} is invalid`);
				}
				const paths = asList(spec.path).map((path) =>
					resolve(path, item, "include"),
				);
				const main = paths[0];
				if (main === undefined) return;
				let dir: string | null;
				if (spec.project_directory !== undefined) {
					const resolved = resolve(
						spec.project_directory,
						item,
						"include project_directory",
					);
					dir = resolved?.[0] ?? null;
				} else dir = main ? posix.dirname(main[0] as string) : null;
				const envFiles = asList(spec.env_file).filter(
					(file) => file !== "/dev/null",
				);
				let env = item.env;
				const loaded: Record<string, string> = {};
				if (envFiles.length) {
					for (const file of envFiles) {
						const path = resolve(file, item, "include env_file");
						if (!path) continue;
						const text = await read(path, "include env_file");
						Object.assign(loaded, parseEnv(text ?? ""));
					}
				} else if (dir !== null) {
					const text = await read([posix.join(dir, ".env")], "", false).catch(
						() => null,
					);
					if (text !== null) Object.assign(loaded, parseEnv(text));
				}
				env = { ...loaded, ...item.env };
				for (const path of paths) {
					if (!path) continue;
					const text = await read(path, "include");
					queue.push({
						file: path[0] as string,
						text: text ?? "",
						dir,
						env,
					});
				}
			});
		}

		const services = isRecord(model.services) ? model.services : {};
		for (const [name, service] of Object.entries(services)) {
			if (!isRecord(service)) continue;
			const extended = service.extends;
			if (isRecord(extended) && extended.file !== undefined) {
				await attempt(async () => {
					const path = resolve(extended.file, item, `${name} extends`);
					if (!path) return;
					const text = await read(path, `${name} extends`);
					const file = path[0] as string;
					queue.push({
						file,
						text: text ?? "",
						dir: posix.dirname(file),
						env: item.env,
					});
				});
			}
			for (const labels of asList(service.label_file)) {
				await attempt(async () => {
					const path = resolve(labels, item, `${name} label_file`);
					if (path) await read(path, `${name} label_file`);
				});
			}
		}
	}
	found.delete(options.composeFile);
	return found;
};
