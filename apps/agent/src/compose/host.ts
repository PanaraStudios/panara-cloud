import { posix } from "node:path";
import { directoryGuard } from "../applications/builders/utils";
import { applyPatches, type Patch } from "../applications/patches";
import { runScript as runCancellableScript } from "../applications/process";
import type { Host } from "../host/types";
import {
	DOCKER_PREAMBLE,
	removeHostPath,
	runScript,
	SUDO_PREAMBLE,
} from "../infra/shell";
import type { RoutingDomain } from "../infra/traefik";
import { PANARA_CLOUD_LABEL, TRAEFIK_CONTAINER } from "../lib/constants";
import { quote } from "../lib/shell";
import type { Mount } from "../lib/swarm";
import {
	type CloneLog,
	type CloneOptions,
	type CloneResult,
	cloneRepository,
} from "../sources/clone";
import {
	assertAppName,
	type ComposeLayout,
	composeEnvPairs,
	composeFlags,
	composeLayout,
	deployCommand,
	envFileContent,
	sanitizeCommand,
	shellEnvContent,
	startCommand,
} from "./command";
import {
	assertCommandPolicy,
	assertComposePolicy,
	bindCommandToProject,
	composeHostPaths,
	type UntrustedScope,
} from "./policy";
import {
	type ComposeSpec,
	type ComposeType,
	listServices,
	parseCompose,
	resolveComposeSpec,
	type ServiceNetworkConfig,
	stringifyCompose,
} from "./transforms";

export type ComposeLog = CloneLog;

// Matches api.compose.agent.getContext (minus job-only fields).
export type ComposeJobInput = {
	compose: {
		id: string;
		organizationId: string;
		projectId: string;
		environmentId: string;
		name: string;
		appName: string;
		composeType: ComposeType;
		sourceType: "raw" | "git";
		composePath: string;
		command: string;
		createEnvFile: boolean;
		randomize: boolean;
		suffix: string;
		isolatedDeployment: boolean;
		isolatedDeploymentsVolume: boolean;
		pullImages: boolean;
	};
	composeFile: string | null;
	env: string;
	projectEnv: string;
	environmentEnv: string;
	domains: RoutingDomain[];
	mounts: Mount[];
	serviceNetworks: ServiceNetworkConfig[];
	// Instance admin deploy: host-level compose settings allowed.
	trusted?: boolean;
};

// How to get the code: write the raw file, clone, or reuse what is on disk.
export type SourcePlan =
	| { type: "raw"; composeFile: string }
	| { type: "clone"; clone: Omit<CloneOptions, "dest"> }
	| { type: "existing" };

export const layoutOf = (input: ComposeJobInput) =>
	composeLayout({
		appName: input.compose.appName,
		sourceType: input.compose.sourceType,
		composePath: input.compose.composePath,
	});

const resolveInput = (input: ComposeJobInput) => ({
	composeId: input.compose.id,
	name: input.compose.name,
	appName: input.compose.appName,
	composeType: input.compose.composeType,
	organizationId: input.compose.organizationId,
	projectId: input.compose.projectId,
	environmentId: input.compose.environmentId,
	randomize: input.compose.randomize,
	suffix: input.compose.suffix,
	isolatedDeployment: input.compose.isolatedDeployment,
	isolatedDeploymentsVolume: input.compose.isolatedDeploymentsVolume,
	domains: input.domains,
	serviceNetworks: input.serviceNetworks,
});

const REFUSED = 7;

// Writes as the SSH user first so the agent can later replace the tree
// without sudo, then retries the same guarded script with sudo for
// root-owned paths. The code directory comes from an untrusted repository
// and is shared with containers through relative bind mounts, so the temp
// file's real location is checked on its open descriptor (a directory
// swapped for a symlink after the guard is caught), and the final rename
// never follows a planted symlink.
export const writeText = async (
	host: Host,
	base: string,
	path: string,
	content: string,
	mode = 0o644,
) => {
	const dir = posix.dirname(path);
	const script = [
		`mkdir -p ${quote(base)} || exit 1`,
		`( set -e\n${directoryGuard(base, path)} ) || exit ${REFUSED}`,
		`mkdir -p ${quote(dir)} || exit 1`,
		`real_base=$(cd ${quote(base)} && pwd -P) || exit 1`,
		`tmp=$(mktemp ${quote(`${dir}/.panara-cloud-write.XXXXXX`)}) || exit 1`,
		'exec 3>"$tmp" || exit 1',
		'case "$(readlink "/proc/$$/fd/3")" in "$real_base"/*) ;; *) rm -f "$tmp"; exit ' +
			`${REFUSED};; esac`,
		`cat >&3 && chmod ${mode.toString(8)} "$tmp" && mv -f "$tmp" ${quote(path)}`,
	].join("\n");
	let result = await host.exec(script, { input: content });
	if (result.code !== 0 && result.code !== REFUSED) {
		result = await host.exec(`sudo -n bash -c ${quote(script)}`, {
			input: content,
		});
	}
	if (result.code === REFUSED) {
		throw new Error(
			`Refusing to write ${path}: its directory is a symlink pointing outside ${base}`,
		);
	}
	if (result.code !== 0) {
		throw new Error(`Could not write ${path}: ${result.output.trim()}`);
	}
};

const MISSING = 3;
const ESCAPES = 4;

// Reads `path` only when the file actually opened stays inside `base`;
// null when it doesn't exist. The check is on the open descriptor, so a
// container swapping the path for a symlink after the check gains nothing.
const readContainedScript = (base: string, path: string) =>
	[
		`base=$(realpath ${quote(base)} 2>/dev/null) || exit ${MISSING}`,
		`[ -f ${quote(path)} ] || exit ${MISSING}`,
		`exec 3< ${quote(path)} || exit ${MISSING}`,
		'real=$(readlink "/proc/$$/fd/3") || exit 1',
		`case "$real" in "$base"/*) ;; *) exit ${ESCAPES};; esac`,
		`[ -f "/proc/$$/fd/3" ] || exit ${MISSING}`,
		"cat <&3",
	].join("\n");

export const readContained = async (
	host: Host,
	base: string,
	path: string,
): Promise<string | null> => {
	const script = readContainedScript(base, path);
	let result = await host.exec(script);
	if (result.code === MISSING) {
		const asRoot = await host.exec(`sudo -n bash -c ${quote(script)}`);
		if (asRoot.code === 0 || asRoot.code === ESCAPES) result = asRoot;
	}
	if (result.code === 0) return result.output;
	if (result.code === ESCAPES) {
		throw new Error(
			`Refusing to read ${path}: it is a symlink pointing outside ${base}`,
		);
	}
	return null;
};

const pathExists = async (host: Host, path: string) =>
	(await host.exec(`test -e ${quote(path)}`)).code === 0;

export const prepareSource = async (
	host: Host,
	layout: ComposeLayout,
	plan: SourcePlan,
	log: ComposeLog,
	signal?: AbortSignal,
): Promise<CloneResult | null> => {
	if (plan.type === "existing") {
		if (!(await pathExists(host, layout.code))) {
			throw new Error(
				"No code on the server yet; deploy the compose service first",
			);
		}
		return null;
	}
	await removeHostPath(host, layout.pristineFile);
	if (plan.type === "raw") {
		await removeHostPath(host, layout.code, { recursive: true });
		await writeText(host, layout.base, layout.composeFile, plan.composeFile);
		log.line("File 'docker-compose.yml' created: ✅");
		return null;
	}
	return await cloneRepository(
		host,
		{ ...plan.clone, dest: layout.code, depth: 1, signal },
		log,
	);
};

// File mounts live in <base>/files and are referenced from the compose
// file as ../files/<filePath>.
export const writeComposeFileMounts = async (
	host: Host,
	layout: ComposeLayout,
	mounts: Mount[],
) => {
	let written = 0;
	for (const mount of mounts) {
		if (mount.type !== "file") continue;
		const relative = posix.normalize(mount.filePath);
		if (
			posix.isAbsolute(relative) ||
			relative === ".." ||
			relative.startsWith("../")
		) {
			throw new Error(`Invalid file mount path: ${mount.filePath}`);
		}
		const target = posix.join(layout.files, relative);
		// Never write through a symlink planted by a container or repository.
		if ((await host.exec(`test -L ${quote(target)}`)).code === 0) {
			throw new Error(`Refusing to write through symlink: ${target}`);
		}
		await writeText(host, layout.files, target, mount.content);
		written++;
	}
	return written;
};

// The untouched source compose file: the pristine copy from the last
// deploy when the code was not refreshed, else the file in the code dir.
export const readSourceCompose = async (
	host: Host,
	layout: ComposeLayout,
): Promise<string> => {
	const text =
		(await readContained(host, layout.state, layout.pristineFile)) ??
		(await readContained(host, layout.base, layout.legacyPristineFile)) ??
		(await readContained(host, layout.code, layout.composeFile));
	if (text === null) {
		throw new Error(
			`Compose file not found: ${layout.composeFileRelative} (check the compose path)`,
		);
	}
	return text;
};

export const renderCompose = (text: string, input: ComposeJobInput) => {
	const source = parseCompose(text);
	const spec = resolveComposeSpec(source, resolveInput(input));
	return {
		yaml: stringifyCompose(spec),
		services: Object.keys(spec.services ?? {}),
	};
};

export const composeServiceNames = (text: string, input: ComposeJobInput) =>
	listServices(parseCompose(text), resolveInput(input));

const commandInput = (input: ComposeJobInput) => ({
	appName: input.compose.appName,
	composeType: input.compose.composeType,
	command: input.compose.command,
	createEnvFile: input.compose.createEnvFile,
	pullImages: input.compose.pullImages,
	hasMounts: input.mounts.some((mount) => mount.type === "file"),
});

const writeEnv = async (
	host: Host,
	layout: ComposeLayout,
	input: ComposeJobInput,
) => {
	const pairs = composeEnvPairs({
		appName: input.compose.appName,
		env: input.env,
		projectEnv: input.projectEnv,
		environmentEnv: input.environmentEnv,
		randomize: input.compose.randomize,
		suffix: input.compose.suffix,
	});
	if (input.compose.createEnvFile) {
		await writeText(
			host,
			layout.code,
			layout.envFile,
			envFileContent(pairs, input.compose.composeType),
			0o600,
		);
	}
	if (input.compose.composeType === "stack") {
		await writeText(
			host,
			layout.state,
			layout.stackEnvFile,
			shellEnvContent(pairs),
			0o600,
		);
		await writeText(
			host,
			layout.state,
			layout.configEnvFile,
			envFileContent(pairs, "docker-compose"),
			0o600,
		);
	}
};

const policyScope = (
	input: ComposeJobInput,
	layout: ComposeLayout,
	relativeTo: string[],
): UntrustedScope => ({
	base: layout.base,
	relativeTo,
	ownedHosts: input.domains.map((domain) => domain.host),
	appName: input.compose.appName,
	fileMounts: input.mounts
		.filter((mount) => mount.type === "file")
		.map((mount) => posix.join(layout.files, posix.normalize(mount.filePath))),
});

const realPaths = async (
	host: Host,
	paths: string[],
): Promise<Map<string, string>> => {
	if (!paths.length) return new Map();
	const result = await host.exec(
		`for p in ${paths.map(quote).join(" ")}; do r=$(realpath -m -- "$p" 2>/dev/null) || r=/; printf '%s\\0' "$r"; done`,
	);
	const real = result.output.split("\0");
	if (result.code !== 0 || real.length < paths.length) {
		throw new Error("Could not resolve the compose file's host paths");
	}
	return new Map(paths.map((path, i) => [path, real[i] ?? "/"]));
};

// Untrusted jobs: let docker compose resolve everything the file can pull
// in (interpolation, include, extends, env files, canonical booleans and
// ports), check that result with host paths resolved on the host, and
// return it as the only file docker will run.
const resolveUntrusted = async (
	host: Host,
	input: ComposeJobInput,
	layout: ComposeLayout,
): Promise<string> => {
	const flags =
		input.compose.composeType === "stack"
			? `-p ${quote(input.compose.appName)} --env-file ${quote(layout.configEnvFile)} -f ${quote(layout.composeFileRelative)}`
			: composeFlags(commandInput(input), layout);
	const config = `env -i PATH="$PATH" HOME="$HOME" $DOCKER compose ${flags} --profile '*' config --no-env-resolution --format json`;
	const result = await host.exec(
		[
			SUDO_PREAMBLE,
			DOCKER_PREAMBLE,
			`cd ${quote(layout.code)} || exit 1`,
			`${config} 2>/dev/null || { ${config} 2>&1 >/dev/null | tail -n 5; exit 1; }`,
		].join("\n"),
	);
	if (result.code !== 0) {
		throw new Error(
			`docker compose could not read the compose file: ${result.output.trim()}`,
		);
	}
	let spec: ComposeSpec;
	try {
		spec = JSON.parse(result.output) as ComposeSpec;
	} catch {
		throw new Error("docker compose config did not return JSON");
	}
	const scope = policyScope(input, layout, ["/"]);
	assertComposePolicy(spec, {
		...scope,
		realPaths: await realPaths(host, composeHostPaths(spec, scope)),
	});
	const resolved = JSON.stringify(
		input.compose.composeType === "stack" ? stackCompatible(spec) : spec,
		null,
		2,
	);
	await writeText(host, layout.state, layout.resolvedFile, resolved, 0o600);
	return resolved;
};

const dropNulls = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(dropNulls);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, v]) => v !== null)
				.map(([k, v]) => [k, dropNulls(v)]),
		);
	}
	return value;
};

// `docker stack deploy` reads the older v3 schema, which is stricter than
// what `docker compose config` prints.
export const stackCompatible = (spec: ComposeSpec): ComposeSpec => {
	const { name: _name, ...rest } = dropNulls(spec) as Record<string, unknown>;
	const services = (rest.services ?? {}) as Record<
		string,
		Record<string, unknown>
	>;
	for (const service of Object.values(services)) {
		if (Array.isArray(service.ports)) {
			service.ports = service.ports.map((port) =>
				port && typeof port === "object" && /^\d+$/.test(String(port.published))
					? { ...port, published: Number(port.published) }
					: port,
			);
		}
		if (Array.isArray(service.extra_hosts)) {
			service.extra_hosts = service.extra_hosts.map((entry) =>
				String(entry).replace("=", ":"),
			);
		}
		const deploy = service.deploy as Record<string, unknown> | undefined;
		const resources = deploy?.resources as
			| Record<string, Record<string, unknown> | undefined>
			| undefined;
		for (const limit of [resources?.limits, resources?.reservations]) {
			if (limit && typeof limit.cpus === "number")
				limit.cpus = String(limit.cpus);
		}
		// Swarm ignores depends_on; the v3 schema only takes a list.
		delete service.depends_on;
	}
	return rest as ComposeSpec;
};

// What untrusted jobs run: always the checked resolved file, under the
// service's own project or stack name.
const untrustedArgs = (
	input: ComposeJobInput,
	layout: ComposeLayout,
	action: "deploy" | "start",
): string => {
	const { compose } = input;
	const file = layout.resolvedFile;
	if (compose.composeType === "stack") {
		if (compose.command.trim()) {
			throw new Error(
				`Custom stack commands are only available to the instance administrator on the panel's organization`,
			);
		}
		return `stack deploy -c ${quote(file)} ${quote(compose.appName)} --prune --with-registry-auth`;
	}
	if (action === "deploy" && compose.command.trim()) {
		const command = sanitizeCommand(compose.command);
		assertCommandPolicy(command);
		return bindCommandToProject(command, compose.appName, file);
	}
	const project = `compose -p ${quote(compose.appName)} -f ${quote(file)}`;
	return action === "start"
		? `${project} up -d`
		: `${project} up -d --build --remove-orphans${compose.pullImages ? " --pull always" : ""}`;
};

const isolatedNetworkScript = (input: ComposeJobInput) => {
	const app = quote(input.compose.appName);
	const driver =
		input.compose.composeType === "stack" ? "--driver overlay " : "";
	return `$DOCKER network inspect ${app} >/dev/null 2>&1 || $DOCKER network create --label ${PANARA_CLOUD_LABEL}=true ${driver}--attachable ${app} >/dev/null`;
};

// `docker stack deploy` doesn't read .env, so the variables are exported
// from the stack env file in a subshell; compose runs with a clean env so
// the agent's own variables never leak into interpolation.
const dockerInvocation = (
	input: ComposeJobInput,
	layout: ComposeLayout,
	args: string,
) =>
	input.compose.composeType === "stack" && input.trusted
		? `( set -a; . ${quote(layout.stackEnvFile)}; set +a; $DOCKER ${args} )`
		: `env -i PATH="$PATH" HOME="$HOME" $DOCKER ${args}`;

// `docker stack rm` returns before the stack's networks are gone; deploying
// again meanwhile fails with "network ... not found". Waits while a stack
// has networks but no services left.
const waitForStackRemoval = (appName: string) =>
	[
		"for i in $(seq 1 30); do",
		`  services="$($DOCKER service ls -q --filter ${quote(`label=com.docker.stack.namespace=${appName}`)})"`,
		`  networks="$($DOCKER network ls -q --filter ${quote(`label=com.docker.stack.namespace=${appName}`)})"`,
		'  if [ -n "$services" ] || [ -z "$networks" ]; then break; fi',
		"  sleep 1",
		"done",
	].join("\n");

export type DeployResult = {
	services: string[];
	commit: CloneResult | null;
	composeFile: string;
};

// Deploys (or rebuilds) a compose: prepare the code, write file
// mounts, resolve the compose file (collision handling, domains, labels),
// write .env and run `docker compose up` or `docker stack deploy`.
export const deployCompose = async (
	host: Host,
	input: ComposeJobInput,
	options: {
		source: SourcePlan;
		freshVolumes?: boolean;
		// Git sources only; patches are skipped for raw compose files.
		patches?: Patch[];
		signal?: AbortSignal;
	},
	log: ComposeLog,
): Promise<DeployResult> => {
	const layout = layoutOf(input);
	const { compose } = input;
	log.line(
		[
			`App Name: ${compose.appName}`,
			`Compose Type: ${compose.composeType}`,
			`Source Type: ${compose.sourceType}`,
			`Domains: ${input.domains.filter((d) => d.enabled).length}`,
			`Mounts: ${input.mounts.filter((m) => m.type === "file").length}`,
		].join("\n"),
	);
	const commit = await prepareSource(
		host,
		layout,
		options.source,
		log,
		options.signal,
	);
	if (options.source.type !== "raw" && options.patches?.length) {
		await applyPatches(host, layout.code, options.patches, log, options.signal);
		// A patch of the compose file itself replaces the source, so the
		// pristine copy is stale.
		if (
			options.patches.some(
				(patch) =>
					posix.normalize(patch.filePath) === layout.composeFileRelative,
			)
		) {
			await removeHostPath(host, layout.pristineFile);
		}
	}
	await writeComposeFileMounts(host, layout, input.mounts);
	const text = await readSourceCompose(host, layout);
	if (!input.trusted) {
		assertComposePolicy(
			parseCompose(text),
			policyScope(input, layout, [
				layout.code,
				posix.dirname(layout.composeFile),
			]),
		);
	}
	const rendered = renderCompose(text, input);
	await writeText(host, layout.state, layout.pristineFile, text, 0o600);
	await removeHostPath(host, layout.legacyPristineFile);
	await writeText(host, layout.code, layout.composeFile, rendered.yaml);
	await writeEnv(host, layout, input);

	let args: string;
	if (input.trusted) args = deployCommand(commandInput(input), layout);
	else {
		await resolveUntrusted(host, input, layout);
		args = untrustedArgs(input, layout, "deploy");
	}
	log.line(`Command: docker ${args}`);
	const lines = ["set -e", `cd ${quote(layout.code)}`];
	if (compose.composeType === "stack") {
		lines.push(waitForStackRemoval(compose.appName));
	}
	if (compose.isolatedDeployment) lines.push(isolatedNetworkScript(input));
	if (options.freshVolumes && compose.composeType === "docker-compose") {
		lines.push(
			`env -i PATH="$PATH" HOME="$HOME" $DOCKER compose -p ${quote(compose.appName)} down --volumes 2>&1 || true`,
		);
	}
	lines.push(
		`${dockerInvocation(input, layout, args)} 2>&1 || { echo "Error: ❌ Docker command failed"; exit 1; }`,
	);
	if (compose.isolatedDeployment) {
		lines.push(
			`$DOCKER network connect ${quote(compose.appName)} ${TRAEFIK_CONTAINER} >/dev/null 2>&1 || true`,
		);
	}
	lines.push(`echo "Docker Compose Deployed: ✅"`);
	// In its own process group, so cancelling the job
	// kills `docker compose up --build` and the builds it spawned.
	await runCancellableScript(
		host,
		[SUDO_PREAMBLE, DOCKER_PREAMBLE, ...lines].join("\n"),
		{ log, signal: options.signal },
	);
	return { services: rendered.services, commit, composeFile: rendered.yaml };
};

export const startCompose = async (
	host: Host,
	input: ComposeJobInput,
	log: ComposeLog,
	signal?: AbortSignal,
) => {
	const layout = layoutOf(input);
	if (!(await pathExists(host, layout.composeFile))) {
		throw new Error("The compose service has not been deployed yet");
	}
	await writeEnv(host, layout, input);
	let args: string;
	if (input.trusted) {
		args =
			input.compose.composeType === "stack"
				? deployCommand({ ...commandInput(input), command: "" }, layout)
				: startCommand(commandInput(input), layout);
	} else {
		// The file on disk is container-writable; check it again.
		await resolveUntrusted(host, input, layout);
		args = untrustedArgs(input, layout, "start");
	}
	const lines = ["set -e", `cd ${quote(layout.code)}`];
	if (input.compose.composeType === "stack") {
		lines.push(waitForStackRemoval(input.compose.appName));
	}
	if (input.compose.isolatedDeployment)
		lines.push(isolatedNetworkScript(input));
	lines.push(`${dockerInvocation(input, layout, args)} 2>&1`);
	if (input.compose.isolatedDeployment) {
		lines.push(
			`$DOCKER network connect ${quote(input.compose.appName)} ${TRAEFIK_CONTAINER} >/dev/null 2>&1 || true`,
		);
	}
	await runScript(host, lines.join("\n"), {
		onOutput: (text) => log.append(text),
		signal,
	});
};

export const stopCompose = async (
	host: Host,
	target: { appName: string; composeType: ComposeType },
	log: ComposeLog,
	signal?: AbortSignal,
) => {
	const app = quote(assertAppName(target.appName));
	const script =
		target.composeType === "stack"
			? `$DOCKER stack rm ${app} 2>&1\n${waitForStackRemoval(target.appName)}`
			: `env -i PATH="$PATH" HOME="$HOME" $DOCKER compose -p ${app} stop 2>&1`;
	await runScript(host, script, {
		onOutput: (text) => log.append(text),
		signal,
	});
};

// Removes a compose: tears the project down and deletes its
// directory and isolated network. Safe to repeat.
export const removeCompose = async (
	host: Host,
	target: { appName: string; composeType: ComposeType; deleteVolumes: boolean },
	log: ComposeLog,
	signal?: AbortSignal,
) => {
	const layout = composeLayout({
		appName: target.appName,
		sourceType: "raw",
		composePath: "docker-compose.yml",
	});
	const app = quote(target.appName);
	const teardown =
		target.composeType === "stack"
			? `$DOCKER stack rm ${app} 2>&1 || true\n${waitForStackRemoval(target.appName)}`
			: `env -i PATH="$PATH" HOME="$HOME" $DOCKER compose -p ${app} down --remove-orphans${target.deleteVolumes ? " --volumes" : ""} 2>&1 || true`;
	const script = [
		`$DOCKER network disconnect ${app} ${TRAEFIK_CONTAINER} >/dev/null 2>&1 || true`,
		teardown,
		// Stack networks are removed asynchronously; retry briefly.
		"for i in 1 2 3 4 5; do",
		`  if [ -z "$($DOCKER network ls -q --filter ${quote(`name=^${target.appName}$`)} --filter label=${PANARA_CLOUD_LABEL}=true)" ]; then break; fi`,
		`  $DOCKER network rm ${app} >/dev/null 2>&1 && break || sleep 2`,
		"done",
	].join("\n");
	await runScript(host, script, {
		onOutput: (text) => log.append(text),
		signal,
	});
	await removeHostPath(host, layout.base, { recursive: true });
	await removeHostPath(host, layout.state, { recursive: true });
	log.line(`Removed ${layout.base}`);
};
