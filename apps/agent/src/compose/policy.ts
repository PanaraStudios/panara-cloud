import { posix } from "node:path";
import { NETWORK_NAME, RESERVED_PORTS } from "../lib/constants";
import { quote } from "../lib/shell";
import type { ComposeSpec } from "./transforms";

// Compose settings that reach the host itself (privileged containers, host
// namespaces, host paths, Docker socket, raw Traefik routers for domains the
// service doesn't own) are honoured only for the instance admin's deploys;
// the backend marks those jobs `trusted`.

export type UntrustedScope = {
	// The service's /etc/panara-cloud/compose/<appName>, which holds code/
	// and files/.
	base: string;
	// Directories relative paths are resolved against (project directory
	// and the compose file's directory).
	relativeTo: string[];
	// Hosts of the service's own domains.
	ownedHosts: string[];
	// The compose project / stack name; volumes and networks the service
	// creates are named after it.
	appName?: string;
	// Absolute paths of the service's file mounts under files/.
	fileMounts?: string[];
	// Host paths resolved with realpath on the host (symlinks followed).
	realPaths?: Map<string, string>;
};

const ADMIN_ONLY =
	"is only available to the instance administrator on the panel's organization";

// Docker's default capability set: adding these back is harmless.
const DEFAULT_CAPS = new Set([
	"AUDIT_WRITE",
	"CHOWN",
	"DAC_OVERRIDE",
	"FOWNER",
	"FSETID",
	"KILL",
	"MKNOD",
	"NET_BIND_SERVICE",
	"NET_RAW",
	"SETFCAP",
	"SETGID",
	"SETPCAP",
	"SETUID",
	"SYS_CHROOT",
]);

const NAMESPACE_KEYS = [
	"network_mode",
	"pid",
	"ipc",
	"uts",
	"userns_mode",
	"cgroup",
];
const PRIVATE_NAMESPACE =
	/^(|none|bridge|default|private|shareable|service:[A-Za-z0-9_.-]+)$/;

// Service keys an untrusted compose may use. Anything else (runtime,
// cgroup_parent, use_api_socket, provider, gpus, credential_spec, ...) is
// refused so new Compose features that reach the host are denied by default.
const SERVICE_KEYS = new Set([
	"annotations",
	"attach",
	"blkio_config",
	"build",
	"cap_add",
	"cap_drop",
	"command",
	"configs",
	"container_name",
	"cpu_count",
	"cpu_percent",
	"cpu_period",
	"cpu_quota",
	"cpu_rt_period",
	"cpu_rt_runtime",
	"cpu_shares",
	"cpus",
	"cpuset",
	"depends_on",
	"deploy",
	"develop",
	"devices",
	"device_cgroup_rules",
	"dns",
	"dns_opt",
	"dns_search",
	"domainname",
	"entrypoint",
	"env_file",
	"environment",
	"expose",
	"extends",
	"external_links",
	"extra_hosts",
	"group_add",
	"healthcheck",
	"hostname",
	"image",
	"init",
	"label_file",
	"labels",
	"links",
	"logging",
	"mac_address",
	"mem_limit",
	"mem_reservation",
	"mem_swappiness",
	"memswap_limit",
	"networks",
	"oom_kill_disable",
	"oom_score_adj",
	"pids_limit",
	"platform",
	"ports",
	"post_start",
	"pre_stop",
	"privileged",
	"profiles",
	"pull_policy",
	"read_only",
	"restart",
	"scale",
	"secrets",
	"security_opt",
	"shm_size",
	"stdin_open",
	"stop_grace_period",
	"stop_signal",
	"storage_opt",
	"sysctls",
	"tmpfs",
	"tty",
	"ulimits",
	"user",
	"volumes",
	"volumes_from",
	"working_dir",
	...NAMESPACE_KEYS,
]);
const TOP_LEVEL_KEYS = new Set([
	"version",
	"name",
	"services",
	"networks",
	"volumes",
	"configs",
	"secrets",
	"include",
]);
const BUILD_DENIED = ["ssh", "privileged", "entitlements", "network"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

const asList = (value: unknown): unknown[] =>
	Array.isArray(value)
		? value
		: value === undefined || value === null
			? []
			: [value];

const isTrue = (value: unknown) =>
	value !== undefined &&
	value !== null &&
	value !== false &&
	!/^(false|no|off|0|)$/i.test(String(value).trim());

const isReservedName = (name: string) =>
	/^panara[-_.]?cloud/i.test(name.trim());

const ROUTER_RULE = /^traefik\.(http|tcp|udp)\.routers\.[^.]+\.rule$/i;
const HOST_CALL = /^(Host|HostSNI)\(\s*([^()]*?)\s*\)/;

const labelEntries = (labels: unknown): [string, string][] => {
	if (Array.isArray(labels)) {
		return labels.map((label) => {
			const text = String(label);
			const at = text.indexOf("=");
			return at === -1 ? [text, ""] : [text.slice(0, at), text.slice(at + 1)];
		});
	}
	if (isRecord(labels)) {
		return Object.entries(labels).map(([k, v]) => [k, String(v ?? "")]);
	}
	return [];
};

const ONLY_OWN_HOSTS =
	"must match only this service's domains: Host(...) of its domains, optionally && further matchers, alternatives joined with ||";

// Splits on `op` outside parentheses and quoted strings; null when the
// rule is unbalanced.
const splitTopLevel = (rule: string, op: string): string[] | null => {
	const parts: string[] = [];
	let depth = 0;
	let quote = "";
	let start = 0;
	for (let i = 0; i < rule.length; i++) {
		const c = rule[i] as string;
		if (quote) {
			if (c === quote) quote = "";
			continue;
		}
		if (c === "`" || c === '"' || c === "'") quote = c;
		else if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth < 0) return null;
		} else if (depth === 0 && rule.startsWith(op, i)) {
			parts.push(rule.slice(start, i).trim());
			start = i + op.length;
			i += op.length - 1;
		}
	}
	if (depth !== 0 || quote) return null;
	parts.push(rule.slice(start).trim());
	return parts;
};

// Every `||` alternative must be a conjunction containing a plain
// Host()/HostSNI() of owned hosts; the other `&&` matchers can only narrow
// it. So `Host(own) && PathPrefix(/api)` passes, while
// `Host(own) || PathPrefix(/)`, `!Host(own)` or HostRegexp don't.
const ruleProblem = (rule: string, owned: Set<string>): string | null => {
	const alternatives = splitTopLevel(rule, "||");
	if (!alternatives) return ONLY_OWN_HOSTS;
	const foreign = new Set<string>();
	for (const alternative of alternatives) {
		const conjuncts = splitTopLevel(alternative, "&&") ?? [];
		let anchored = false;
		for (const conjunct of conjuncts) {
			const match = HOST_CALL.exec(conjunct);
			if (!match || match[0].length !== conjunct.length) continue;
			const hosts: string[] = [];
			for (const arg of (match[2] ?? "").split(",")) {
				const quoted = /^([`"'])([^`"']+)\1$/.exec(arg.trim());
				if (!quoted) return ONLY_OWN_HOSTS;
				hosts.push((quoted[2] ?? "").toLowerCase());
			}
			for (const host of hosts) if (!owned.has(host)) foreign.add(host);
			anchored = true;
		}
		if (!anchored) return ONLY_OWN_HOSTS;
	}
	return foreign.size
		? `routes ${[...foreign].join(", ")}, which is not one of this service's domains`
		: null;
};

const publishedPorts = (port: unknown): number[] => {
	let published: string;
	if (isRecord(port)) {
		published = String(port.published ?? "");
	} else {
		const text = String(port).replace(/\/(tcp|udp|sctp)$/i, "");
		const parts = text.startsWith("[")
			? text.replace(/^\[[^\]]*\]:/, "").split(":")
			: text.split(":");
		if (parts.length < 2) return [];
		published = parts.at(-2) ?? "";
	}
	const range = /^(\d+)(?:-(\d+))?$/.exec(published.trim());
	if (!range) return published.trim() ? [Number.NaN] : [];
	const from = Number(range[1]);
	const to = Number(range[2] ?? range[1]);
	const ports: number[] = [];
	for (let p = from; p <= Math.min(to, from + 65535); p++) ports.push(p);
	return ports;
};

const isUrl = (value: string) =>
	/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("git@");

// Every host path the policy checks, so the caller can resolve them on the
// host (realpath) and pass them back as `realPaths`.
export const composeHostPaths = (
	spec: ComposeSpec,
	scope: UntrustedScope,
): string[] => {
	const found = new Set<string>();
	composePolicyProblems(spec, { ...scope, realPaths: undefined }, (path) =>
		found.add(path),
	);
	return [...found];
};

export const composePolicyProblems = (
	spec: ComposeSpec,
	scope: UntrustedScope,
	onPath?: (path: string) => void,
): string[] => {
	const problems: string[] = [];
	const owned = new Set(scope.ownedHosts.map((h) => h.toLowerCase()));
	const base = posix.normalize(scope.base).replace(/\/+$/, "");
	const files = `${base}/files`;
	const fileMounts = new Set(
		(scope.fileMounts ?? []).map((path) => posix.normalize(path)),
	);
	const appName = scope.appName;
	const root = spec as Record<string, unknown>;

	// Inside the service's directory, but never the directory itself or
	// files/ (which the agent writes as root); only exact file mounts there.
	const allowedPath = (path: string) =>
		path.startsWith(`${base}/`) &&
		path !== files &&
		(!path.startsWith(`${files}/`) || fileMounts.has(path));

	const checkPath = (where: string, value: unknown) => {
		if (typeof value !== "string" || !value) return;
		if (isUrl(value)) return;
		if (value.includes("$") || value.startsWith("~")) {
			problems.push(`${where}: host path "${value}" uses variables or ~`);
			return;
		}
		const resolved = scope.relativeTo.map((dir) => posix.resolve(dir, value));
		for (const path of resolved) onPath?.(path);
		const escapes = resolved.some((path) => {
			if (!allowedPath(path)) return true;
			const real = scope.realPaths?.get(path);
			return real !== undefined && !allowedPath(real);
		});
		if (escapes) {
			problems.push(
				`${where}: host path "${value}" is outside the service's directory`,
			);
		}
	};

	const isHostPath = (source: string) =>
		source.includes("/") ||
		source.startsWith(".") ||
		source.startsWith("~") ||
		source.includes("$");

	for (const key of Object.keys(root)) {
		if (!TOP_LEVEL_KEYS.has(key) && !key.startsWith("x-")) {
			problems.push(`${key} (top-level)`);
		}
	}

	for (const [name, service] of Object.entries(spec.services ?? {})) {
		if (!isRecord(service)) continue;
		const at = `services.${name}`;
		for (const key of Object.keys(service)) {
			if (!SERVICE_KEYS.has(key) && !key.startsWith("x-")) {
				problems.push(`${at}.${key}`);
			}
		}
		if (isTrue(service.privileged)) problems.push(`${at}.privileged`);
		for (const hook of [
			...asList(service.post_start),
			...asList(service.pre_stop),
		]) {
			if (isRecord(hook) && isTrue(hook.privileged)) {
				problems.push(`${at} lifecycle hook privileged`);
			}
		}
		for (const key of NAMESPACE_KEYS) {
			const value = service[key];
			if (value === undefined || value === null) continue;
			if (!PRIVATE_NAMESPACE.test(String(value).trim())) {
				problems.push(`${at}.${key}: ${String(value)}`);
			}
		}
		for (const cap of asList(service.cap_add)) {
			const name = String(cap).toUpperCase().replace(/^CAP_/, "");
			if (!DEFAULT_CAPS.has(name)) problems.push(`${at}.cap_add: ${cap}`);
		}
		if (asList(service.devices).length) problems.push(`${at}.devices`);
		if (asList(service.device_cgroup_rules).length) {
			problems.push(`${at}.device_cgroup_rules`);
		}
		for (const opt of asList(service.security_opt)) {
			if (!/^no-new-privileges([:=]true)?$/.test(String(opt))) {
				problems.push(`${at}.security_opt: ${opt}`);
			}
		}
		for (const from of asList(service.volumes_from)) {
			if (String(from).startsWith("container:")) {
				problems.push(`${at}.volumes_from: ${from}`);
			}
		}
		for (const volume of asList(service.volumes)) {
			if (typeof volume === "string") {
				const source = volume.split(":")[0] ?? "";
				if (volume.includes(":") && isHostPath(source)) {
					checkPath(`${at}.volumes`, source);
				}
			} else if (isRecord(volume)) {
				const type = volume.type ?? "volume";
				if (type === "bind") checkPath(`${at}.volumes`, volume.source);
				else if (type !== "volume" && type !== "tmpfs") {
					problems.push(`${at}.volumes: type ${String(type)}`);
				}
			}
		}
		for (const port of asList(service.ports)) {
			for (const published of publishedPorts(port)) {
				if (Number.isNaN(published)) {
					problems.push(`${at}.ports: unreadable published port`);
				} else if (RESERVED_PORTS.has(published)) {
					problems.push(`${at}.ports: ${published} is reserved for the panel`);
				}
			}
		}
		for (const envFile of asList(service.env_file)) {
			checkPath(`${at}.env_file`, isRecord(envFile) ? envFile.path : envFile);
		}
		for (const labelFile of asList(service.label_file)) {
			checkPath(`${at}.label_file`, labelFile);
		}
		const build = service.build;
		if (typeof build === "string") checkPath(`${at}.build`, build);
		else if (isRecord(build)) {
			checkPath(`${at}.build.context`, build.context);
			for (const key of BUILD_DENIED) {
				if (
					build[key] !== undefined &&
					build[key] !== null &&
					!(key === "privileged" && !isTrue(build[key])) &&
					!(key === "network" && PRIVATE_NAMESPACE.test(String(build[key])))
				) {
					problems.push(`${at}.build.${key}`);
				}
			}
			const extra = build.additional_contexts;
			for (const value of isRecord(extra)
				? Object.values(extra)
				: asList(extra).map((e) => String(e).split("=").slice(1).join("="))) {
				if (typeof value === "string" && !value.startsWith("docker-image://")) {
					checkPath(`${at}.build.additional_contexts`, value);
				}
			}
		}
		if (isRecord(service.extends)) {
			checkPath(`${at}.extends.file`, service.extends.file);
		}
		const deploy = isRecord(service.deploy) ? service.deploy : {};
		for (const [key, value] of [
			...labelEntries(service.labels),
			...labelEntries(deploy.labels),
		]) {
			// Docker sets these itself; agent lookups trust them.
			if (/^com\.docker\./i.test(key.trim())) {
				problems.push(`${at}.labels ${key} is set by Docker`);
				continue;
			}
			if (!ROUTER_RULE.test(key)) continue;
			const problem = ruleProblem(value, owned);
			if (problem) problems.push(`${at}.labels ${key} ${problem}`);
		}
	}

	for (const section of ["configs", "secrets"] as const) {
		const entries = root[section];
		if (!isRecord(entries)) continue;
		for (const [name, entry] of Object.entries(entries)) {
			if (!isRecord(entry)) continue;
			checkPath(`${section}.${name}.file`, entry.file);
			if (isTrue(entry.external)) problems.push(`${section}.${name}.external`);
		}
	}
	const ownName = (name: string) =>
		!isReservedName(name) &&
		(appName === undefined ||
			name === appName ||
			name.startsWith(`${appName}_`));
	const volumes = root.volumes;
	if (isRecord(volumes)) {
		for (const [name, volume] of Object.entries(volumes)) {
			if (!isRecord(volume)) continue;
			if (isTrue(volume.external)) {
				problems.push(`volumes.${name}: external volumes`);
			}
			if (typeof volume.name === "string" && !ownName(volume.name)) {
				problems.push(
					`volumes.${name}: name "${volume.name}" belongs to another service`,
				);
			}
			if (volume.driver !== undefined && volume.driver !== "local") {
				problems.push(`volumes.${name}.driver: ${String(volume.driver)}`);
			}
			if (!isRecord(volume.driver_opts)) continue;
			const opts = volume.driver_opts;
			const device = String(opts.device ?? "");
			if (
				/\bbind\b/.test(String(opts.o ?? "")) ||
				String(opts.type ?? "") === "none" ||
				device.startsWith("/") ||
				device.startsWith(".")
			) {
				problems.push(`volumes.${name}.driver_opts binds a host path`);
			}
		}
	}
	const networks = root.networks;
	if (isRecord(networks)) {
		for (const [name, network] of Object.entries(networks)) {
			if (!isRecord(network) || !isTrue(network.external)) continue;
			const target = String(network.name ?? name);
			if (target !== NETWORK_NAME && target !== appName) {
				problems.push(`networks.${name}: external network "${target}"`);
			}
		}
	}
	for (const include of asList(root.include)) {
		if (typeof include === "string") checkPath("include", include);
		else if (isRecord(include)) {
			for (const path of asList(include.path)) checkPath("include", path);
			for (const path of asList(include.env_file)) checkPath("include", path);
			checkPath("include.project_directory", include.project_directory);
		}
	}
	return problems;
};

export const assertComposePolicy = (
	spec: ComposeSpec,
	scope: UntrustedScope,
) => {
	const problems = composePolicyProblems(spec, scope);
	if (problems.length) {
		throw new Error(
			`These compose settings reach the host and ${ADMIN_ONLY}:\n- ${problems.join("\n- ")}`,
		);
	}
};

const COMPOSE_SUBCOMMANDS = new Set([
	"build",
	"config",
	"create",
	"down",
	"kill",
	"logs",
	"pause",
	"ps",
	"pull",
	"restart",
	"rm",
	"start",
	"stop",
	"unpause",
	"up",
]);
const VALUED_FLAGS = new Set([
	"-p",
	"--project-name",
	"-f",
	"--file",
	"--env-file",
	"--profile",
	"--ansi",
	"--parallel",
	"--progress",
	"-c",
	"--compose-file",
]);
const HOST_FLAGS =
	/^(-v|--volume|--privileged|--cap-add|--device|--security-opt|--pid|--ipc|--network|--project-directory|--mount)(=|$)/;

// Custom commands (already through sanitizeCommand, without the leading
// `docker`) may only run `docker compose` (or `docker stack deploy` for
// stacks) on the service's own files.
export const assertCommandPolicy = (command: string) => {
	const parts = command
		.split("&&")
		.map((part, index) =>
			(index === 0
				? part
				: part.trim().replace(/^(docker\s+compose|docker-compose)\b/, "compose")
			)
				.trim()
				.split(/\s+/),
		);
	for (const tokens of parts) {
		const [tool, ...args] = tokens;
		const stack = tool === "stack" && args[0] === "deploy";
		if (tool !== "compose" && !stack) {
			throw new Error(
				`Only "docker compose" commands are allowed; "docker ${tool}" ${ADMIN_ONLY}`,
			);
		}
		for (const arg of args) {
			if (HOST_FLAGS.test(arg)) {
				throw new Error(`The compose command flag ${arg} ${ADMIN_ONLY}`);
			}
			const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
			if (
				value.startsWith("/") ||
				value.startsWith("~") ||
				value.split("/").includes("..")
			) {
				throw new Error(
					`The compose command may only use paths inside the service's directory (got ${arg})`,
				);
			}
		}
		if (stack) continue;
		for (let i = 0; i < args.length; i++) {
			const arg = args[i] ?? "";
			if (arg.startsWith("-")) {
				if (VALUED_FLAGS.has(arg)) i++;
				continue;
			}
			if (!COMPOSE_SUBCOMMANDS.has(arg)) {
				throw new Error(
					`"docker compose ${arg}" is not allowed in a custom command; use one of ${[...COMPOSE_SUBCOMMANDS].join(", ")}`,
				);
			}
			break;
		}
	}
};

const GLOBAL_VALUED = new Set([
	"--profile",
	"--ansi",
	"--progress",
	"--parallel",
]);
const GLOBAL_SWITCHES = new Set(["--dry-run", "--compatibility"]);

// Rewrites an untrusted custom command (already through assertCommandPolicy)
// so every `docker compose` part acts on the service's own project and the
// checked resolved file; flags choosing other files or projects are refused.
export const bindCommandToProject = (
	command: string,
	appName: string,
	file: string,
): string =>
	command
		.split("&&")
		.map((part, index) => {
			const tokens = (
				index === 0
					? part
					: part
							.trim()
							.replace(/^(docker\s+compose|docker-compose)\b/, "compose")
			)
				.trim()
				.split(/\s+/);
			const [tool, ...args] = tokens;
			if (tool !== "compose") {
				throw new Error(`Custom "docker ${tool}" commands ${ADMIN_ONLY}`);
			}
			const globals: string[] = [];
			let i = 0;
			for (; i < args.length; i++) {
				const arg = args[i] ?? "";
				if (!arg.startsWith("-")) break;
				const name = arg.split("=")[0] ?? "";
				if (GLOBAL_SWITCHES.has(arg)) globals.push(arg);
				else if (GLOBAL_VALUED.has(name)) {
					globals.push(arg);
					if (!arg.includes("=")) globals.push(args[++i] ?? "");
				} else {
					throw new Error(`The compose command flag ${name} ${ADMIN_ONLY}`);
				}
			}
			return [
				index === 0 ? "compose" : "docker compose",
				"-p",
				quote(appName),
				"-f",
				quote(file),
				...globals,
				...args.slice(i),
			].join(" ");
		})
		.join(" && ");
