import { posix } from "node:path";
import { quote } from "../lib/shell";
import { type ComposeLayout, sanitizeCommand } from "./command";
import { type ComposeSpec, parseCompose, stringifyCompose } from "./transforms";

// Every deploy runs a snapshot kept in the agent's state folder, never the
// files under the service's folder: containers may bind and rewrite
// anything there, and a trusted job runs what it is given with host
// privileges. Compose snapshots are `docker compose config` output; stack
// snapshots are the rendered YAML (`docker stack deploy` reads the older v3
// schema and rejects fields `config` prints) with relative paths made
// absolute, since `docker stack deploy` resolves them against the file's
// own folder.

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

const asList = (value: unknown): unknown[] =>
	Array.isArray(value)
		? value
		: value === undefined || value === null
			? []
			: [value];

const isRelative = (path: string) =>
	path === "." || path === ".." || /^\.\.?\//.test(path);

export const stackSnapshot = (yaml: string, dir: string): string => {
	const spec = parseCompose(yaml) as Record<string, unknown>;
	const absolute = (path: unknown) =>
		typeof path === "string" && isRelative(path)
			? posix.resolve(dir, path)
			: path;
	const services = isRecord(spec.services) ? spec.services : {};
	for (const service of Object.values(services)) {
		if (!isRecord(service)) continue;
		if (Array.isArray(service.volumes)) {
			service.volumes = service.volumes.map((volume) => {
				if (typeof volume === "string") {
					const [source = "", ...rest] = volume.split(":");
					return rest.length && isRelative(source)
						? [absolute(source), ...rest].join(":")
						: volume;
				}
				if (isRecord(volume) && (volume.type ?? "volume") === "bind") {
					return { ...volume, source: absolute(volume.source) };
				}
				return volume;
			});
		}
		if (service.env_file !== undefined) {
			const files = asList(service.env_file).map((entry) =>
				isRecord(entry)
					? { ...entry, path: absolute(entry.path) }
					: absolute(entry),
			);
			service.env_file = Array.isArray(service.env_file) ? files : files[0];
		}
	}
	for (const section of ["configs", "secrets"] as const) {
		const entries = spec[section];
		if (!isRecord(entries)) continue;
		for (const entry of Object.values(entries)) {
			if (isRecord(entry) && entry.file !== undefined) {
				entry.file = absolute(entry.file);
			}
		}
	}
	return stringifyCompose(spec as ComposeSpec);
};

// What Docker reads or mounts from the host when it runs a resolved file
// (`docker compose config` output: absolute sources, long syntax).
// `writable` marks mounts a container can write through.
export type HostPath = { path: string; writable: boolean; what: string };

const optionList = (value: unknown) =>
	String(value ?? "")
		.split(",")
		.map((option) => option.trim());

// A local volume whose driver options mount a host folder, as policy.ts
// recognises one.
export const volumeDevice = (
	volume: unknown,
): { device: string; writable: boolean } | null => {
	if (!isRecord(volume) || !isRecord(volume.driver_opts)) return null;
	const opts = volume.driver_opts;
	const device = String(opts.device ?? "");
	const options = optionList(opts.o);
	if (
		!options.includes("bind") &&
		!options.includes("rbind") &&
		String(opts.type ?? "") !== "none" &&
		!device.startsWith("/") &&
		!device.startsWith(".")
	) {
		return null;
	}
	return device ? { device, writable: !options.includes("ro") } : null;
};

export const hostPaths = (spec: ComposeSpec): HostPath[] => {
	const found: HostPath[] = [];
	const root = spec as Record<string, unknown>;
	const services = isRecord(root.services) ? root.services : {};
	for (const [name, service] of Object.entries(services)) {
		if (!isRecord(service)) continue;
		for (const volume of asList(service.volumes)) {
			if (!isRecord(volume) || volume.type !== "bind") continue;
			const source = String(volume.source ?? "");
			if (source) {
				found.push({
					path: source,
					writable: volume.read_only !== true,
					what: `${name} mounts`,
				});
			}
		}
		for (const entry of asList(service.env_file)) {
			const path = isRecord(entry) ? entry.path : entry;
			if (typeof path === "string" && path) {
				found.push({ path, writable: false, what: `${name} reads env_file` });
			}
		}
		const build = service.build;
		const context = isRecord(build) ? build.context : build;
		if (typeof context === "string" && context.startsWith("/")) {
			found.push({
				path: context,
				writable: false,
				what: `${name} builds from`,
			});
		}
	}
	for (const section of ["configs", "secrets"] as const) {
		const entries = root[section];
		if (!isRecord(entries)) continue;
		for (const [name, entry] of Object.entries(entries)) {
			if (isRecord(entry) && typeof entry.file === "string" && entry.file) {
				found.push({
					path: entry.file,
					writable: false,
					what: `${section}.${name} reads`,
				});
			}
		}
	}
	const volumes = isRecord(root.volumes) ? root.volumes : {};
	for (const [name, volume] of Object.entries(volumes)) {
		const bound = volumeDevice(volume);
		if (bound) {
			found.push({
				path: bound.device,
				writable: bound.writable,
				what: `volume ${name} mounts`,
			});
		}
	}
	return found;
};

// Host folders a container must not be able to change: the system, root's
// and users' homes (SSH keys), Docker's state. `/`, `/var`, `/var/lib` and
// `/run` themselves too, but not what is in them (data folders, the Docker
// socket). The service's own folder under /etc/panara-cloud/compose is
// allowed.
export const PROTECTED_TREES = [
	"/root",
	"/home",
	"/etc",
	"/boot",
	"/usr",
	"/bin",
	"/sbin",
	"/lib",
	"/lib64",
	"/var/lib/docker",
	"/var/lib/containerd",
];
export const PROTECTED_EXACT = ["/", "/var", "/var/lib", "/run", "/var/run"];

export const normalHostPath = (path: string) =>
	posix.normalize(posix.resolve("/", path)).replace(/\/+$/, "") || "/";

const within = (path: string, folder: string) =>
	path === folder || path.startsWith(`${folder}/`);

const casePattern = (path: string) => quote(path);

// GNU `realpath -m`; BusyBox's realpath has no -m, and without it no mount
// can be checked. The probe exits REALPATH_MISSING.
export const REALPATH_MISSING = 9;
export const REALPATH_MESSAGE =
	"this server's realpath has no -m option (BusyBox's realpath lacks it), so Panara Cloud cannot check where mounts lead; install GNU coreutils";
export const REALPATH_PROBE = `realpath -m -- / >/dev/null 2>&1 || exit ${REALPATH_MISSING}`;

// Whether every existing folder on a resolved path is searchable by this
// user. `realpath -m` run without root stops resolving at a folder it can't
// search and goes on as if the rest had no symlinks; its answer is trusted
// only when there was no such folder.
const SEARCHABLE = [
	"panara_searchable() {",
	'  _p=""; _rest="${1#/}"',
	"  [ -x / ] || return 1",
	'  while [ -n "$_rest" ]; do',
	'    case "$_rest" in */*) _c="${_rest%%/*}"; _rest="${_rest#*/}";; *) _c="$_rest"; _rest="";; esac',
	'    _p="$_p/$_c"',
	'    if [ -d "$_p" ]; then [ -x "$_p" ] || return 1',
	'    elif [ ! -e "$_p" ] && [ ! -L "$_p" ]; then return 0',
	"    fi",
	"  done",
	"}",
];

// Runs in the same script as the docker command, just before it: Docker
// follows symlinks in what it mounts or reads, and a container can plant one
// in its own folder at any time. Every path is resolved on the host as root
// sees it (`$SUDO`); without sudo, as this user, and only where every folder
// on the way is searchable. A path in the service's folder must stay there
// (a link out of it can only have been planted); a writable mount must not
// land in a protected host folder. A path that cannot be resolved is
// refused.
export const runtimeGuard = (paths: HostPath[], base: string): string[] => {
	const seen = new Set<string>();
	const lines: string[] = [];
	const own = `${casePattern(base)}|${casePattern(base)}/*`;
	const protectedCase = [
		...PROTECTED_EXACT.map(casePattern),
		...PROTECTED_TREES.flatMap((tree) => [
			casePattern(tree),
			`${casePattern(tree)}/*`,
		]),
	].join("|");
	for (const entry of paths) {
		if (!entry.path.startsWith("/")) continue;
		const path = normalHostPath(entry.path);
		const inside = within(path, base);
		if (!inside && !entry.writable) continue;
		const key = `${path}\0${inside}\0${entry.writable}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const refuse = (why: string) =>
			`echo ${quote(`Error: ❌ Refusing to run: ${entry.what} ${path}, which ${why} `)}"$real"; exit 1`;
		lines.push(
			`if real=$($SUDO realpath -m -- ${quote(path)} 2>/dev/null) && [ -n "$real" ]; then :`,
			`elif [ -n "$SUDO" ] && real=$(realpath -m -- ${quote(path)} 2>/dev/null) && [ -n "$real" ] && panara_searchable "$real"; then :`,
			`else echo ${quote(`Error: ❌ Refusing to run: cannot tell where ${entry.what} ${path} leads: a folder on the way is not searchable by this user, and sudo -n is not available`)}; exit 1; fi`,
			inside
				? `case "$real" in ${own}) ;; *) ${refuse("is a symlink out of the service's folder to")};; esac`
				: `case "$real" in ${own}) ;; ${protectedCase}) ${refuse("resolves to the protected host folder")};; esac`,
		);
	}
	if (!lines.length) return lines;
	return [
		`realpath -m -- / >/dev/null 2>&1 || { echo ${quote(`Error: ❌ Refusing to run: ${REALPATH_MESSAGE}`)}; exit 1; }`,
		...SEARCHABLE,
		...lines,
	];
};

const FILE_FLAGS = new Set(["-f", "--file", "-c", "--compose-file"]);
const PATH_FLAGS = new Set([
	...FILE_FLAGS,
	"-v",
	"--volume",
	"--mount",
	"--env-file",
	"--label-file",
	"--project-directory",
]);
const COMPOSE_VALUED = new Set([
	"-p",
	"--project-name",
	"--profile",
	"--ansi",
	"--parallel",
	"--progress",
]);

const refuseFile = (arg: string) =>
	new Error(
		`A custom command can only name this service's own compose file and .env, which run from the deploy's checked snapshot; other files in the service's folder can be changed by its containers (got ${arg}). Pull them into the compose file with \`include:\` or \`extends:\` instead.`,
	);

// A flag and its value, whether written `--flag value` or `--flag=value`.
const flagAt = (args: string[], i: number) => {
	const arg = args[i] ?? "";
	const at = arg.indexOf("=");
	if (arg.startsWith("--") && at !== -1) {
		return { name: arg.slice(0, at), value: arg.slice(at + 1), next: i };
	}
	return { name: arg, value: args[i + 1] ?? "", next: i + 1 };
};

// Paths into the service's folder, or relative ones (which resolve there),
// are refused wherever a flag takes a host path.
const assertNoServicePaths = (args: string[], base: string) => {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		const flag = flagAt(args, i);
		if (!PATH_FLAGS.has(flag.name)) continue;
		i = flag.next;
		const source =
			flag.name === "--mount"
				? (/(?:^|,)(?:source|src)=([^,]*)/.exec(flag.value)?.[1] ?? "")
				: flag.name === "-v" || flag.name === "--volume"
					? (flag.value.split(":")[0] ?? "")
					: flag.value;
		if (
			(flag.name === "-v" ||
				flag.name === "--volume" ||
				flag.name === "--mount") &&
			!source.includes("/")
		) {
			continue;
		}
		if (!source.startsWith("/") || within(normalHostPath(source), base)) {
			throw refuseFile(`${flag.name} ${flag.value}`);
		}
	}
};

// A trusted custom command, run on the deploy's snapshot: `-f`/`-c` of the
// service's own compose file become the snapshot, `--env-file` of its own
// .env and the deploy's project directory are already applied in it, and
// any other file in the service's folder is refused.
export const bindTrustedCommand = (
	command: string,
	layout: ComposeLayout,
	appName: string,
	snapshot: string,
): string => {
	const own = (path: string) =>
		normalHostPath(posix.resolve(layout.code, path));
	return sanitizeCommand(command)
		.split("&&")
		.map((part, index) => {
			const [tool = "", ...args] = (
				index === 0
					? part
					: part
							.trim()
							.replace(/^(docker\s+compose|docker-compose)\b/, "compose")
			)
				.trim()
				.split(/\s+/);
			const prefix = index === 0 ? "" : "docker ";
			if (tool === "stack" && args[0] === "deploy") {
				const kept: string[] = ["deploy"];
				for (let i = 1; i < args.length; i++) {
					const flag = flagAt(args, i);
					if (FILE_FLAGS.has(flag.name)) {
						if (own(flag.value) !== layout.composeFile) {
							throw refuseFile(`${flag.name} ${flag.value}`);
						}
						kept.push("-c", quote(snapshot));
						i = flag.next;
					} else kept.push(args[i] ?? "");
				}
				assertNoServicePaths(kept.slice(1), layout.base);
				return `${prefix}stack ${kept.join(" ")}`;
			}
			if (tool !== "compose") {
				assertNoServicePaths(args, layout.base);
				return `${prefix}${[tool, ...args].join(" ")}`;
			}
			const globals: string[] = [];
			let project = false;
			let i = 0;
			for (; i < args.length; i++) {
				const arg = args[i] ?? "";
				if (!arg.startsWith("-")) break;
				const flag = flagAt(args, i);
				if (FILE_FLAGS.has(flag.name)) {
					if (own(flag.value) !== layout.composeFile) {
						throw refuseFile(`${flag.name} ${flag.value}`);
					}
					i = flag.next;
				} else if (flag.name === "--env-file") {
					if (own(flag.value) !== layout.envFile) {
						throw refuseFile(`${flag.name} ${flag.value}`);
					}
					i = flag.next;
				} else if (flag.name === "--project-directory") {
					const dir = own(flag.value);
					if (
						dir !== layout.code &&
						dir !== posix.dirname(layout.composeFile)
					) {
						throw refuseFile(`${flag.name} ${flag.value}`);
					}
					i = flag.next;
				} else if (COMPOSE_VALUED.has(flag.name)) {
					if (flag.name === "-p" || flag.name === "--project-name") {
						project = true;
					}
					globals.push(arg);
					if (flag.next !== i) globals.push(args[++i] ?? "");
				} else globals.push(arg);
			}
			const rest = args.slice(i);
			assertNoServicePaths(rest, layout.base);
			return [
				`${prefix}compose`,
				...(project ? [] : ["-p", quote(appName)]),
				...globals,
				"-f",
				quote(snapshot),
				...rest,
			].join(" ");
		})
		.join(" && ");
};
