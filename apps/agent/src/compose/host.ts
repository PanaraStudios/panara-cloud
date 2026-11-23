import { posix } from "node:path";
import { directoryGuard } from "../applications/builders/utils";
import { applyPatches, type Patch } from "../applications/patches";
import {
	CancelledError,
	runScript as runCancellableScript,
} from "../applications/process";
import type { Host } from "../host/types";
import {
	DOCKER_PREAMBLE,
	removeHostPath,
	runScript,
	SUDO_PREAMBLE,
	splitSections,
} from "../infra/shell";
import type { RoutingDomain } from "../infra/traefik";
import {
	anonymousVolumes,
	NO_VOLUME_OUTCOME,
	removeUnusedVolumes,
	type VolumeCandidate,
	type VolumeChecks,
	type VolumeOutcome,
} from "../infra/volumeRemoval";
import { PANARA_CLOUD_LABEL, TRAEFIK_CONTAINER } from "../lib/constants";
import { afterHandoff } from "../lib/handoff";
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
	type ComposePlan,
	type ComposeVersion,
	composeEnvPairs,
	composeFlags,
	composeLayout,
	composePlan,
	deployCommand,
	envFileContent,
	parseComposeVersion,
	sanitizeCommand,
	shellEnvContent,
	startCommand,
	upArgs,
} from "./command";
import { removeBuiltImages } from "./images";
import type { ContainerMount } from "./inspect";
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
	plan?: ComposePlan,
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
	const project = untrustedProject(input, layout);
	return action === "start"
		? `${project} up -d`
		: `${project} ${upArgs(compose.pullImages, plan)}`;
};

const untrustedProject = (input: ComposeJobInput, layout: ComposeLayout) =>
	`compose -p ${quote(input.compose.appName)} -f ${quote(layout.resolvedFile)}`;

// The pulls and builds of a deploy, as their own commands before `up`, so a
// cancel can still stop a deploy before any container is touched
// (composePlan says what `up` is left with). A custom command can't be
// split: it is all handed over at once, like `docker stack deploy`, which
// only tells Swarm what to run.
export const preparationArgs = (
	input: ComposeJobInput,
	layout: ComposeLayout,
	plan: ComposePlan,
): { args: string; mayFail: boolean }[] => {
	const { compose } = input;
	if (compose.composeType === "stack" || compose.command.trim()) return [];
	const project = input.trusted
		? `compose ${composeFlags(commandInput(input), layout)}`
		: untrustedProject(input, layout);
	return [
		...(plan.pull
			? [{ args: `${project} ${plan.pull.args}`, mayFail: plan.pull.mayFail }]
			: []),
		{ args: `${project} build`, mayFail: false },
	];
};

// Unknown (no `docker compose`, or an answer that isn't a version) plans as
// the oldest version, which leaves pulling to `up`.
const composeVersion = async (host: Host): Promise<ComposeVersion | null> => {
	const result = await host.exec(
		[
			SUDO_PREAMBLE,
			DOCKER_PREAMBLE,
			"$DOCKER compose version --short 2>/dev/null",
		].join("\n"),
	);
	return result.code === 0 ? parseComposeVersion(result.output) : null;
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

	const splits =
		compose.composeType === "docker-compose" && !compose.command.trim();
	const version = splits ? await composeVersion(host) : null;
	if (splits) {
		log.line(
			`Docker Compose: ${version ? version.join(".") : "unknown version"}`,
		);
	}
	const plan = composePlan(compose.pullImages, version);
	let args: string;
	if (input.trusted) args = deployCommand(commandInput(input), layout, plan);
	else {
		await resolveUntrusted(host, input, layout);
		args = untrustedArgs(input, layout, "deploy", plan);
	}
	const preparation = preparationArgs(input, layout, plan);
	for (const step of preparation) log.line(`Preparing: docker ${step.args}`);
	log.line(`Command: docker ${args}`);
	await runDeployScripts(
		host,
		deployScripts(input, layout, {
			preparation,
			args,
			freshVolumes: options.freshVolumes ?? false,
		}),
		log,
		options.signal,
	);
	return { services: rendered.services, commit, composeFile: rendered.yaml };
};

// What deployCompose runs on the host: `prepare` while a cancel can still
// stop the deploy, `apply` once the project is handed to Docker. Clearing
// the volumes of a fresh deploy waits for `apply`, so a cancelled build
// leaves the running project as it was.
export const deployScripts = (
	input: ComposeJobInput,
	layout: ComposeLayout,
	steps: {
		preparation: ReturnType<typeof preparationArgs>;
		args: string;
		freshVolumes: boolean;
	},
) => {
	const { compose } = input;
	const script = (lines: string[]) =>
		[
			SUDO_PREAMBLE,
			DOCKER_PREAMBLE,
			"set -e",
			`cd ${quote(layout.code)}`,
			...lines,
		].join("\n");
	const failed = `|| { echo "Error: ❌ Docker command failed"; exit 1; }`;
	const prepare = [
		...(compose.composeType === "stack"
			? [waitForStackRemoval(compose.appName)]
			: []),
		...steps.preparation.map(
			(step) =>
				`${dockerInvocation(input, layout, step.args)} 2>&1 ${step.mayFail ? "|| true" : failed}`,
		),
	];
	const apply = [
		...(compose.isolatedDeployment ? [isolatedNetworkScript(input)] : []),
		...(steps.freshVolumes && compose.composeType === "docker-compose"
			? [
					`env -i PATH="$PATH" HOME="$HOME" $DOCKER compose -p ${quote(compose.appName)} down --volumes 2>&1 || true`,
				]
			: []),
		`${dockerInvocation(input, layout, steps.args)} 2>&1 ${failed}`,
		...(compose.isolatedDeployment
			? [
					`$DOCKER network connect ${quote(compose.appName)} ${TRAEFIK_CONTAINER} >/dev/null 2>&1 || true`,
				]
			: []),
		`echo "Docker Compose Deployed: ✅"`,
	];
	return { prepare: script(prepare), apply: script(apply) };
};

// Both scripts run in their own process group, so a cancel during `prepare`
// kills the pulls and builds it spawned. Once `docker compose up` (or
// `docker stack deploy`) starts, it replaces containers one after another,
// and stopping it half-way could leave some of the new ones up under a
// deployment that reads "Cancelled": from there it runs to its end.
export const runDeployScripts = async (
	host: Host,
	scripts: { prepare: string; apply: string },
	log: ComposeLog,
	signal?: AbortSignal,
) => {
	await runCancellableScript(host, scripts.prepare, { log, signal });
	if (signal?.aborted) throw new CancelledError();
	await afterHandoff(() => runCancellableScript(host, scripts.apply, { log }), {
		signal,
		onLateCancel: () =>
			log.line(
				"Cancel arrived after docker started replacing containers: the deploy goes on.",
			),
	});
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

// `docker stack rm` never removes volumes, and the stack's containers hold
// them for a while after it returns, so each removal is retried.
const removeStackVolumes = (appName: string) =>
	[
		`for volume in $($DOCKER volume ls -q --filter ${quote(`label=com.docker.stack.namespace=${appName}`)}); do`,
		"  for i in $(seq 1 15); do",
		'    if $DOCKER volume rm "$volume" >/dev/null 2>&1; then echo "Removed volume $volume"; break; fi',
		'    if [ "$i" = 15 ]; then echo "Could not remove volume $volume"; else sleep 2; fi',
		"  done",
		"done",
	].join("\n");

const projectLabel = (target: { appName: string; composeType: ComposeType }) =>
	`label=${target.composeType === "stack" ? "com.docker.stack.namespace" : "com.docker.compose.project"}=${target.appName}`;

// The volumes that are the project's own: the named ones Docker labelled with
// it when it created them, and the anonymous ones of its containers. Read
// before teardown, while the containers still say what they mount; a volume
// the project only uses (external, or created by another project) is not its
// own and is never a candidate.
export const projectVolumes = async (
	host: Host,
	target: { appName: string; composeType: ComposeType },
	signal?: AbortSignal,
): Promise<VolumeCandidate[]> => {
	const label = quote(projectLabel(target));
	const sections = splitSections(
		await runScript(
			host,
			[
				'echo "<<named"',
				`$DOCKER volume ls -q --filter ${label} || exit 1`,
				'echo "<<mounts"',
				`ids=$($DOCKER ps -aq --filter ${label}) || exit 1`,
				`[ -z "$ids" ] || $DOCKER inspect --format '{{json .Mounts}}' $ids 2>/dev/null || true`,
			].join("\n"),
			{ signal },
		),
	);
	const mounts = (sections.mounts ?? []).flatMap((line) => {
		try {
			const parsed: unknown = JSON.parse(line);
			return Array.isArray(parsed) ? (parsed as ContainerMount[]) : [];
		} catch {
			return [];
		}
	});
	return [
		...(sections.named ?? []).map((name) => ({ name: name.trim() })),
		...anonymousVolumes(mounts),
	];
};

// Removes a compose: tears the project down and deletes its directory,
// isolated network and the images it built that nothing else uses
// (images.ts). With `deleteVolumes` and `checks`, its own volumes go too
// unless something else still uses them (the outcome says which were kept).
// Without `checks` (a transfer dropping the source copy) they are removed as
// Docker allows. Safe to repeat.
export const removeCompose = async (
	host: Host,
	target: { appName: string; composeType: ComposeType; deleteVolumes: boolean },
	log: ComposeLog,
	options: { signal?: AbortSignal; checks?: VolumeChecks } = {},
): Promise<VolumeOutcome> => {
	const { signal, checks } = options;
	const layout = composeLayout({
		appName: target.appName,
		sourceType: "raw",
		composePath: "docker-compose.yml",
	});
	const app = quote(target.appName);
	const unchecked = target.deleteVolumes && !checks;
	const candidates =
		target.deleteVolumes && checks
			? await projectVolumes(host, target, signal)
			: [];
	const teardown =
		target.composeType === "stack"
			? `$DOCKER stack rm ${app} 2>&1 || true\n${waitForStackRemoval(target.appName)}${unchecked ? `\n${removeStackVolumes(target.appName)}` : ""}`
			: `env -i PATH="$PATH" HOME="$HOME" $DOCKER compose -p ${app} down --remove-orphans${unchecked ? " --volumes" : ""} 2>&1 || true`;
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
	await removeBuiltImages(
		host,
		target.appName,
		(line) => log.line(line),
		signal,
	);
	const outcome =
		checks && candidates.length > 0
			? await removeUnusedVolumes(host, {
					...checks,
					candidates,
					deleting: [target.appName],
					log: (text) => log.append(text),
					signal,
				})
			: NO_VOLUME_OUTCOME;
	await removeHostPath(host, layout.base, { recursive: true });
	await removeHostPath(host, layout.state, { recursive: true });
	log.line(`Removed ${layout.base}`);
	return outcome;
};
