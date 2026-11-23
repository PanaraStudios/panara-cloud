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
import {
	PANARA_CLOUD_LABEL,
	paths as panaraPaths,
	TRAEFIK_CONTAINER,
} from "../lib/constants";
import { envObject, parseEnv } from "../lib/env";
import { afterHandoff } from "../lib/handoff";
import { quote } from "../lib/shell";
import type { Mount } from "../lib/swarm";
import {
	type CloneLog,
	type CloneOptions,
	type CloneResult,
	cloneRepository,
	removeEscapingSymlinks,
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
	envFileContent,
	parseComposeVersion,
	sanitizeCommand,
	shellEnvContent,
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
	bindTrustedCommand,
	hostPaths,
	normalHostPath,
	PROTECTED_EXACT,
	PROTECTED_TREES,
	REALPATH_MESSAGE,
	REALPATH_MISSING,
	REALPATH_PROBE,
	runtimeGuard,
	stackSnapshot,
	volumeDevice,
} from "./snapshot";
import {
	collectSourceFiles,
	type FileLookup,
	SourceFileError,
} from "./sourceFiles";
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
	input: ComposeJobInput,
	plan: SourcePlan,
	log: ComposeLog,
	options: { signal?: AbortSignal; patches?: Patch[] } = {},
): Promise<CloneResult | null> => {
	const layout = layoutOf(input);
	// Stale files of older agents; the legacy copy sits where containers
	// can write, so it is never read.
	await removeHostPaths(host, [
		layout.legacyPristineFile,
		...layout.obsoleteFiles,
	]);
	if (plan.type === "existing") {
		if (!(await pathExists(host, layout.code))) {
			throw new Error(
				"No code on the server yet; deploy the compose service first",
			);
		}
		return null;
	}
	if (plan.type === "raw") {
		await removeHostPath(host, layout.capture, { recursive: true });
		// code/ is the project directory, so `./` bind mounts keep their data
		// in it: a redeploy rewrites the compose file and .env but never
		// clears it. Only the first raw deploy after a git source clears the
		// checkout it left.
		const previous = await previousSource(host, layout);
		if (previous === "git") {
			await removeHostPath(host, layout.code, { recursive: true });
		} else {
			await removeHostPath(host, layout.envFile);
			if (previous === null && (await pathExists(host, layout.code))) {
				log.line(
					`Kept ${layout.code}: no earlier source is recorded for it, so what is in it stays`,
				);
			}
		}
		await writeText(host, layout.base, layout.composeFile, plan.composeFile);
		await recordSource(host, layout, "raw");
		log.line("File 'docker-compose.yml' created: ✅");
		return null;
	}
	// The clone lands in the state folder first: the old containers still
	// run, and one that can reach code/ could otherwise rewrite the files
	// before they are captured.
	const cloned = await cloneRepository(
		host,
		{ ...plan.clone, dest: layout.checkout, depth: 1, signal: options.signal },
		log,
	);
	try {
		await captureSource(host, input, layout, options.patches ?? []);
		await placeCheckout(host, layout);
	} catch (error) {
		await removeHostPath(host, layout.capture, { recursive: true });
		throw error;
	} finally {
		await removeHostPath(host, layout.checkout, { recursive: true });
	}
	await recordSource(host, layout, "git");
	return cloned;
};

const removeHostPaths = async (host: Host, paths: string[]) => {
	const rm = `rm -f ${paths.map(quote).join(" ")}`;
	await host.run(`${rm} 2>/dev/null || sudo -n ${rm}`);
};

// Copies the compose file and every file it pulls in from the fresh clone
// into `layout.capture`. Lenient: what can't be followed now is refused when
// the deploy resolves the file.
const captureSource = async (
	host: Host,
	input: ComposeJobInput,
	layout: ComposeLayout,
	patches: Patch[],
) => {
	const captured = new Map<string, string>();
	const fromCheckout = async (path: string) => {
		const text = await readContained(
			host,
			layout.checkout,
			posix.join(layout.checkout, path),
		);
		if (text !== null) captured.set(path, text);
		return text;
	};
	const top = await fromCheckout(layout.composeFileRelative);
	if (top === null) {
		throw new Error(
			`Compose file not found: ${layout.composeFileRelative} (check the compose path)`,
		);
	}
	const lookup = sourceLookup(input, layout, patches, fromCheckout);
	await collectSourceFiles({
		...(await loadOptions(input, layout, lookup)),
		text: patchedText(patches, layout.composeFileRelative) ?? top,
		lookup,
		strict: false,
	}).catch(() => {});
	await removeHostPath(host, layout.capture, { recursive: true });
	for (const [path, text] of captured) {
		await writeText(
			host,
			layout.state,
			posix.join(layout.capture, path),
			text,
			0o600,
		);
	}
};

// Replaces code/ with the checkout. `mv -T` fails rather than nest the
// checkout in a folder a container recreated meanwhile.
const placeCheckout = async (host: Host, layout: ComposeLayout) => {
	await removeHostPath(host, layout.code, { recursive: true });
	const move = `mv -T -- ${quote(layout.checkout)} ${quote(layout.code)}`;
	const result = await host.exec(
		`mkdir -p ${quote(layout.base)} && { ${move} 2>/dev/null || sudo -n ${move}; }`,
	);
	if (result.code !== 0) {
		throw new Error(
			`Could not move the checkout to ${layout.code}: ${result.output.trim()}`,
		);
	}
	// Links that only resolved inside the checkout where it was cloned.
	await host.run(removeEscapingSymlinks(quote(layout.code)));
};

const patchedText = (
	patches: Patch[],
	path: string,
): string | null | undefined => {
	const patch = patches.find(
		(candidate) => posix.normalize(candidate.filePath) === path,
	);
	if (!patch) return undefined;
	return patch.type === "delete" ? null : patch.content;
};

const envPairsOf = (input: ComposeJobInput) =>
	composeEnvPairs({
		appName: input.compose.appName,
		env: input.env,
		projectEnv: input.projectEnv,
		environmentEnv: input.environmentEnv,
		randomize: input.compose.randomize,
		suffix: input.compose.suffix,
	});

// What a file in the service's folder holds for a trusted load, by path
// relative to the folder: the panel's file mounts and .env, the deploy's
// patches, else the commit's copy (`fromCommit`; null for a raw source,
// which has no other files). Nothing is read from the folder itself.
const sourceLookup = (
	input: ComposeJobInput,
	layout: ComposeLayout,
	patches: Patch[],
	fromCommit: ((path: string) => Promise<string | null>) | null,
	rendered?: string,
): FileLookup => {
	const mounts = new Map(
		input.mounts.flatMap((mount) =>
			mount.type === "file"
				? [[posix.normalize(mount.filePath), mount.content] as const]
				: [],
		),
	);
	const env = input.compose.createEnvFile
		? envFileContent(envPairsOf(input), input.compose.composeType)
		: null;
	return async (path) => {
		if (path.startsWith("files/")) {
			const content = mounts.get(path.slice("files/".length));
			if (content === undefined) {
				throw new SourceFileError(
					`../${path} is not one of the service's file mounts`,
				);
			}
			return content;
		}
		if (!path.startsWith("code/")) {
			throw new SourceFileError(
				`${path} is outside the service's code and file mounts`,
			);
		}
		const relative = path.slice("code/".length);
		if (rendered !== undefined && relative === layout.composeFileRelative) {
			return rendered;
		}
		if (env !== null && relative === layout.envFileRelative) return env;
		if (fromCommit === null) {
			throw new SourceFileError(
				`${relative}: a raw compose file can only pull in the service's file mounts (../files/…)`,
			);
		}
		const patched = patchedText(patches, relative);
		return patched !== undefined ? patched : await fromCommit(relative);
	};
};

const fromCapture = (host: Host, layout: ComposeLayout) => (path: string) =>
	readContained(host, layout.capture, posix.join(layout.capture, path));

// Where docker compose loads the compose file from, and the variables it
// interpolates it with: the panel's env when "Create .env file" is on,
// else the commit's .env in the project directory (which docker compose
// loaded on its own before), else none.
const loadOptions = async (
	input: ComposeJobInput,
	layout: ComposeLayout,
	lookup: FileLookup,
) => {
	const projectDir = posix.relative(
		layout.base,
		projectDirectory(input, layout),
	);
	const envPath = posix.join(projectDir, ".env");
	const envText = input.compose.createEnvFile
		? null
		: await lookup(envPath).catch(() => null);
	return {
		base: layout.base,
		composeFile: posix.relative(layout.base, layout.composeFile),
		projectDir,
		env: input.compose.createEnvFile
			? envObject(envPairsOf(input))
			: parseEnv(envText ?? ""),
		envFile: envText === null ? null : { path: envPath, text: envText },
	};
};

// The source of the last deploy, kept in the agent's state folder (out of the
// containers' reach). Nothing is inferred when it was never recorded: a
// container can create a `.git` folder in code/ through a `./` mount.
const sourceFile = (layout: ComposeLayout) => `${layout.state}/source`;

const recordSource = (
	host: Host,
	layout: ComposeLayout,
	source: "raw" | "git",
) => writeText(host, layout.state, sourceFile(layout), `${source}\n`, 0o600);

const previousSource = async (
	host: Host,
	layout: ComposeLayout,
): Promise<"raw" | "git" | null> => {
	const recorded = (
		await readContained(host, layout.state, sourceFile(layout))
	)?.trim();
	return recorded === "git" || recorded === "raw" ? recorded : null;
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

// The untouched source compose file of a git source: the deploy's patch of
// it, else the commit's copy captured at the last clone. The checkout in
// code/ is never read (its containers can change it, and a deploy leaves
// the rendered file there).
export const readSourceCompose = async (
	host: Host,
	layout: ComposeLayout,
	patches: Patch[] = [],
): Promise<string> => {
	const patched = patchedText(patches, layout.composeFileRelative);
	const text =
		patched !== undefined
			? patched
			: await fromCapture(host, layout)(layout.composeFileRelative);
	if (text === null) {
		throw new Error(
			`Compose file not found: ${layout.composeFileRelative} (check the compose path, or deploy with a fresh clone)`,
		);
	}
	return text;
};

// Whether a redeploy can reuse the code on the server: only with the
// commit's copies captured when it was cloned.
export const hasCapture = async (host: Host, input: ComposeJobInput) => {
	const layout = layoutOf(input);
	return (
		(
			await host.exec(
				`test -f ${quote(posix.join(layout.capture, layout.composeFileRelative))}`,
			)
		).code === 0
	);
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
	const pairs = envPairsOf(input);
	if (input.compose.createEnvFile) {
		await writeText(
			host,
			layout.code,
			layout.envFile,
			envFileContent(pairs, input.compose.composeType),
			0o600,
		);
	}
	// The copy `docker compose config` reads: the one in code/ is the
	// containers' to change.
	await writeText(
		host,
		layout.state,
		layout.configEnvFile,
		envFileContent(pairs, "docker-compose"),
		0o600,
	);
	if (input.compose.composeType === "stack") {
		await writeText(
			host,
			layout.state,
			layout.stackEnvFile,
			shellEnvContent(pairs),
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
		`${REALPATH_PROBE}\nfor p in ${paths.map(quote).join(" ")}; do r=$(realpath -m -- "$p" 2>/dev/null) || r=/; printf '%s\\0' "$r"; done`,
	);
	if (result.code === REALPATH_MISSING) {
		throw new Error(`Refusing to run: ${REALPATH_MESSAGE}`);
	}
	const real = result.output.split("\0");
	if (result.code !== 0 || real.length < paths.length) {
		throw new Error("Could not resolve the compose file's host paths");
	}
	return new Map(paths.map((path, i) => [path, real[i] ?? "/"]));
};

// `docker compose config` of a file, as JSON; it fails the job when docker
// compose can't read the file, so nothing is run unchecked.
const composeConfig = async (
	host: Host,
	cwd: string,
	flags: string,
): Promise<{ spec: ComposeSpec; text: string }> => {
	const config = `env -i PATH="$PATH" HOME="$HOME" $DOCKER compose ${flags} --profile '*' config --no-env-resolution --format json`;
	const result = await host.exec(
		[
			SUDO_PREAMBLE,
			DOCKER_PREAMBLE,
			`cd ${quote(cwd)} || exit 1`,
			`${config} 2>/dev/null || { ${config} 2>&1 >/dev/null | tail -n 5; exit 1; }`,
		].join("\n"),
	);
	if (result.code !== 0) {
		throw new Error(
			`docker compose could not read the compose file: ${result.output.trim()}`,
		);
	}
	try {
		return {
			spec: JSON.parse(result.output) as ComposeSpec,
			text: result.output,
		};
	} catch {
		throw new Error("docker compose config did not return JSON");
	}
};

// Untrusted jobs: let docker compose resolve everything the file can pull
// in (interpolation, include, extends, env files, canonical booleans and
// ports), check that result with host paths resolved on the host, and
// return it as the only file docker will run.
const resolveUntrusted = async (
	host: Host,
	input: ComposeJobInput,
	layout: ComposeLayout,
): Promise<Snapshot> => {
	const flags =
		input.compose.composeType === "stack"
			? `-p ${quote(input.compose.appName)} --env-file ${quote(layout.configEnvFile)} -f ${quote(layout.composeFileRelative)}`
			: composeFlags(commandInput(input), layout);
	const { spec } = await composeConfig(host, layout.code, flags);
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
	return { file: layout.resolvedFile, text: resolved, spec };
};

// What a job runs: the file in the agent's state folder, its content (kept
// as the deployed snapshot once the deploy succeeds), and the resolved spec
// the checks read.
type Snapshot = { file: string; text: string; spec: ComposeSpec };

// Relative paths resolve where the deploy always resolved them: in code/
// with file mounts (--project-directory), else in the compose file's folder.
const projectDirectory = (input: ComposeJobInput, layout: ComposeLayout) =>
	commandInput(input).hasMounts
		? layout.code
		: posix.dirname(layout.composeFile);

// A trusted job's snapshot of a rendered compose file, resolved by docker
// compose from copies in the agent's state folder: the rendered file, and
// the files it pulls in taken from the commit or the panel (`lookup`), laid
// out under `layout.mirror` at the host paths they stand for. Relative
// paths resolve exactly as in the service's folder and are mapped back
// after, and nothing a container can change in that folder is read.
const trustedSnapshot = async (
	host: Host,
	input: ComposeJobInput,
	layout: ComposeLayout,
	rendered: string,
	lookup: FileLookup,
): Promise<Snapshot> => {
	const { compose } = input;
	if (compose.composeType === "stack") {
		assertStackLoadsNothing(rendered);
		const text = stackSnapshot(rendered, posix.dirname(layout.composeFile));
		await writeText(host, layout.state, layout.stackFile, text, 0o600);
		return {
			file: layout.stackFile,
			text,
			spec: await stackChecks(host, input, layout, layout.stackFile),
		};
	}
	const load = await loadOptions(input, layout, lookup);
	let files: Map<string, string>;
	try {
		files = await collectSourceFiles({
			...load,
			text: rendered,
			lookup,
			strict: true,
		});
	} catch (error) {
		if (!(error instanceof SourceFileError)) throw error;
		throw new Error(`Refusing to deploy: ${error.message}`);
	}
	const mirrored = (path: string) => `${layout.mirror}${path}`;
	const inBase = (path: string) => posix.join(layout.base, path);
	await removeHostPath(host, layout.mirror, { recursive: true });
	if (load.envFile) files.set(load.envFile.path, load.envFile.text);
	for (const [path, text] of files) {
		await writeText(host, layout.state, mirrored(inBase(path)), text, 0o600);
	}
	await writeText(
		host,
		layout.state,
		mirrored(layout.composeFile),
		rendered,
		0o600,
	);
	let envFile = layout.configEnvFile;
	if (!compose.createEnvFile) {
		envFile = load.envFile
			? mirrored(inBase(load.envFile.path))
			: layout.emptyEnvFile;
		if (!load.envFile) {
			await writeText(host, layout.state, layout.emptyEnvFile, "", 0o600);
		}
	}
	const dir = mirrored(projectDirectory(input, layout));
	const { spec } = await composeConfig(
		host,
		dir,
		[
			"-p",
			quote(compose.appName),
			"--project-directory",
			quote(dir),
			"--env-file",
			quote(envFile),
			"-f",
			quote(mirrored(layout.composeFile)),
		].join(" "),
	);
	const resolved = fromMirror(spec, layout);
	const text = JSON.stringify(resolved, null, 2);
	await writeText(host, layout.state, layout.resolvedFile, text, 0o600);
	return { file: layout.resolvedFile, text, spec: resolved };
};

// Maps the mirror's paths in `docker compose config` output back to the host
// paths they stand for. `label_file` is dropped: its labels are already
// merged in, and `up` would read the file again from the service's folder.
const fromMirror = (
	spec: ComposeSpec,
	layout: Pick<ComposeLayout, "mirror">,
): ComposeSpec => {
	const map = (value: unknown): unknown => {
		if (typeof value === "string") {
			if (value === layout.mirror) return "/";
			if (value.startsWith(`${layout.mirror}/`)) {
				return value.slice(layout.mirror.length);
			}
			if (
				value === panaraPaths.composeState ||
				value.startsWith(`${panaraPaths.composeState}/`)
			) {
				throw new Error(
					`Refusing to deploy: a path in the compose file resolves to ${value}, above the host's root`,
				);
			}
			return value;
		}
		if (Array.isArray(value)) return value.map(map);
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).map(([key, entry]) => [key, map(entry)]),
			);
		}
		return value;
	};
	const resolved = map(spec) as ComposeSpec;
	for (const service of Object.values(resolved.services ?? {})) {
		if (service && typeof service === "object") {
			delete (service as Record<string, unknown>).label_file;
		}
	}
	return resolved;
};

// `docker stack deploy` refuses include, extends and label_file; refusing
// them first keeps the checks from reading files of the service's folder.
const assertStackLoadsNothing = (rendered: string) => {
	const spec = parseCompose(rendered) as Record<string, unknown>;
	const found: string[] = [];
	if (spec.include !== undefined) found.push("include");
	const services = (spec.services ?? {}) as Record<string, unknown>;
	for (const [name, service] of Object.entries(services)) {
		if (!service || typeof service !== "object") continue;
		const fields = service as Record<string, unknown>;
		if (fields.extends !== undefined) found.push(`${name}: extends`);
		if (fields.label_file !== undefined) found.push(`${name}: label_file`);
	}
	if (found.length) {
		throw new Error(
			`docker stack deploy does not support ${found.join(", ")}; write them out in the stack file`,
		);
	}
};

// A stack snapshot keeps its variables for `docker stack deploy`; the
// checks read it as docker compose resolves it with the same values.
const stackChecks = async (
	host: Host,
	input: ComposeJobInput,
	layout: ComposeLayout,
	file: string,
) =>
	(
		await composeConfig(
			host,
			layout.state,
			`-p ${quote(input.compose.appName)} --env-file ${quote(layout.configEnvFile)} -f ${quote(file)}`,
		)
	).spec;

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

// What a deploy runs: always its snapshot, under the service's own project
// or stack name. A trusted custom command runs on the snapshot too
// (bindTrustedCommand); an untrusted one is held to the policy.
export const deployArgs = (
	input: ComposeJobInput,
	layout: ComposeLayout,
	file: string,
	plan: ComposePlan,
): string => {
	const { compose } = input;
	const command = compose.command.trim();
	if (command && input.trusted) {
		return bindTrustedCommand(command, layout, compose.appName, file);
	}
	if (compose.composeType === "stack") {
		if (command) {
			throw new Error(
				`Custom stack commands are only available to the instance administrator on the panel's organization`,
			);
		}
		return stackDeploy(compose.appName, file);
	}
	if (command) {
		const sanitized = sanitizeCommand(command);
		assertCommandPolicy(sanitized);
		return bindCommandToProject(sanitized, compose.appName, file);
	}
	return `${snapshotProject(input, file)} ${upArgs(compose.pullImages, plan)}`;
};

// Start brings the project up as its last deploy left it.
export const startArgs = (input: ComposeJobInput, file: string): string =>
	input.compose.composeType === "stack"
		? stackDeploy(input.compose.appName, file)
		: `${snapshotProject(input, file)} up -d`;

const stackDeploy = (appName: string, file: string) =>
	`stack deploy -c ${quote(file)} ${quote(appName)} --prune --with-registry-auth`;

const snapshotProject = (input: ComposeJobInput, file: string) =>
	`compose -p ${quote(input.compose.appName)} -f ${quote(file)}`;

// The pulls and builds of a deploy, as their own commands before `up`, so a
// cancel can still stop a deploy before any container is touched
// (composePlan says what `up` is left with). A custom command can't be
// split: it is all handed over at once, like `docker stack deploy`, which
// only tells Swarm what to run.
export const preparationArgs = (
	input: ComposeJobInput,
	file: string,
	plan: ComposePlan,
): { args: string; mayFail: boolean }[] => {
	const { compose } = input;
	if (compose.composeType === "stack" || compose.command.trim()) return [];
	const project = snapshotProject(input, file);
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
	const patches = options.source.type === "raw" ? [] : (options.patches ?? []);
	const commit = await prepareSource(host, input, options.source, log, {
		signal: options.signal,
		patches,
	});
	if (patches.length) {
		await applyPatches(host, layout.code, patches, log, options.signal);
	}
	await writeComposeFileMounts(host, layout, input.mounts);
	// A raw file is taken as the panel sent it, a git one from the commit's
	// copy captured at the clone: never read back from code/, where a
	// container could have replaced it.
	const text =
		options.source.type === "raw"
			? options.source.composeFile
			: await readSourceCompose(host, layout, patches);
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
	const snapshot = input.trusted
		? await trustedSnapshot(
				host,
				input,
				layout,
				rendered.yaml,
				sourceLookup(
					input,
					layout,
					patches,
					options.source.type === "raw" ? null : fromCapture(host, layout),
					rendered.yaml,
				),
			)
		: await resolveUntrusted(host, input, layout);
	const args = deployArgs(input, layout, snapshot.file, plan);
	await checkMounts(host, input, layout, snapshot.spec, log, {
		orphans: !options.freshVolumes,
	});
	const preparation = preparationArgs(input, snapshot.file, plan);
	for (const step of preparation) log.line(`Preparing: docker ${step.args}`);
	log.line(`Command: docker ${args}`);
	await runDeployScripts(
		host,
		deployScripts(input, layout, {
			preparation,
			args,
			freshVolumes: options.freshVolumes ?? false,
			guard: runtimeGuard(hostPaths(snapshot.spec), layout.base),
		}),
		log,
		options.signal,
	);
	await recordDeployed(host, input, layout, snapshot.text).catch((error) =>
		log.line(
			`⚠️ Could not keep this deploy's snapshot for Start: ${error instanceof Error ? error.message : String(error)}`,
		),
	);
	return { services: rendered.services, commit, composeFile: rendered.yaml };
};

const deployedFile = (input: ComposeJobInput, layout: ComposeLayout) =>
	input.compose.composeType === "stack"
		? layout.deployedStackFile
		: layout.deployedFile;

const recordDeployed = (
	host: Host,
	input: ComposeJobInput,
	layout: ComposeLayout,
	text: string,
) => writeText(host, layout.state, deployedFile(input, layout), text, 0o600);

const PROTECTED_EXACT_SET = new Set(PROTECTED_EXACT);

const isProtectedHostPath = (path: string, ownFolder: string): boolean => {
	const normal = normalHostPath(path);
	if (normal === ownFolder || normal.startsWith(`${ownFolder}/`)) return false;
	if (PROTECTED_EXACT_SET.has(normal)) return true;
	return PROTECTED_TREES.some(
		(tree) => normal === tree || normal.startsWith(`${tree}/`),
	);
};

type ResolvedVolume = {
	type?: unknown;
	source?: unknown;
	read_only?: unknown;
};

const serviceVolumes = (spec: ComposeSpec) =>
	Object.entries(spec.services ?? {}).flatMap(([name, service]) =>
		(Array.isArray(service?.volumes) ? (service.volumes as unknown[]) : []).map(
			(volume) => ({ name, volume: volume as ResolvedVolume }),
		),
	);

// Writable mounts of protected host folders in a resolved compose file
// (`docker compose config`: absolute sources, long syntax): bind mounts, and
// named volumes whose driver options bind a host folder. These paths are
// read as written; runtimeGuard checks where they really lead just before
// Docker runs.
export const protectedBinds = (
	spec: ComposeSpec,
	ownFolder: string,
): string[] => [
	...serviceVolumes(spec).flatMap(({ name, volume }) => {
		if (!volume || typeof volume !== "object" || volume.type !== "bind") {
			return [];
		}
		const source = String(volume.source ?? "");
		if (!source || volume.read_only === true) return [];
		return isProtectedHostPath(source, ownFolder)
			? [`${name} mounts the host's ${normalHostPath(source)} writable`]
			: [];
	}),
	...Object.entries(
		((spec as { volumes?: Record<string, unknown> }).volumes ?? {}) as Record<
			string,
			unknown
		>,
	).flatMap(([name, volume]) => {
		const bound = volumeDevice(volume);
		return bound?.writable && isProtectedHostPath(bound.device, ownFolder)
			? [
					`volume ${name} mounts the host's ${normalHostPath(bound.device)} writable`,
				]
			: [];
	}),
];

export const assertNoProtectedBinds = (
	spec: ComposeSpec,
	ownFolder: string,
) => {
	const found = protectedBinds(spec, ownFolder);
	if (found.length) {
		throw new Error(
			`Refusing to run: ${found.join("; ")}. A container can take ownership of such a folder (a template that mounted /root locked SSH, and with it Panara Cloud, out of its server). Mount it read-only (:ro) or use a named volume.`,
		);
	}
};

// Bind mounts inside the project directory (code/), in a resolved file.
export const bindsInsideProject = (spec: ComposeSpec, code: string): string[] =>
	serviceVolumes(spec).flatMap(({ name, volume }) => {
		if (!volume || typeof volume !== "object" || volume.type !== "bind") {
			return [];
		}
		const source = posix.normalize(String(volume.source ?? ""));
		return source === code || source.startsWith(`${code}/`)
			? [`${name} mounts ${source}`]
			: [];
	});

// Volume names in a resolved compose file (`docker compose config`), and
// the keys of those docker compose left with a variable in their name.
export const resolvedVolumeNames = (
	spec: ComposeSpec,
): { names: string[]; unresolved: { key: string; name: string }[] } => {
	const volumes = (spec as { volumes?: Record<string, unknown> }).volumes;
	const names: string[] = [];
	const unresolved: { key: string; name: string }[] = [];
	if (!volumes || typeof volumes !== "object") return { names, unresolved };
	for (const [key, volume] of Object.entries(volumes)) {
		const name = (volume as { name?: unknown } | null)?.name;
		if (typeof name !== "string" || !name) continue;
		if (name.includes("$")) unresolved.push({ key, name });
		else names.push(name);
	}
	return { names, unresolved };
};

const VARIABLE = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/;

// Volumes an earlier deploy of this project created that the compose file
// no longer names: a renamed volume key, a variable in a volume name, or
// "Randomize names" switched. Docker keeps them, but the deploy mounts new,
// empty ones, which looks like lost data; the log says where it still is.
// `existing` lines are `name` or `name<TAB>volume key` (the
// com.docker.compose.volume label).
export const orphanedVolumes = (
	existing: string[],
	expected: { names: string[]; unresolved: { key: string; name: string }[] },
): string[] => {
	const wanted = new Set(expected.names);
	// A name with a variable matches the values that keep its literal text;
	// a name that is nothing but variables can only be told by its key.
	const patterns: RegExp[] = [];
	const keys = new Set<string>();
	for (const { key, name } of expected.unresolved) {
		const parts = name.split(new RegExp(VARIABLE.source, "g"));
		if (!parts.join("")) {
			keys.add(key);
			continue;
		}
		patterns.push(
			new RegExp(
				`^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+")}$`,
			),
		);
	}
	return existing.flatMap((line) => {
		const [name = "", key = ""] = line.trim().split("\t");
		return name &&
			!wanted.has(name) &&
			!(key && keys.has(key)) &&
			!patterns.some((pattern) => pattern.test(name)) &&
			!/^[0-9a-f]{64}$/.test(name)
			? [name]
			: [];
	});
};

// Before Docker runs the snapshot: a trusted job refuses writable mounts of
// protected host folders (the untrusted policy refuses every host path),
// and the log names mounts that would quietly lose or misplace data.
const checkMounts = async (
	host: Host,
	input: ComposeJobInput,
	layout: ComposeLayout,
	resolved: ComposeSpec,
	log: ComposeLog,
	options: { orphans: boolean },
) => {
	const { compose } = input;
	if (input.trusted) assertNoProtectedBinds(resolved, layout.base);
	try {
		if (compose.sourceType === "git") {
			for (const bind of bindsInsideProject(resolved, layout.code)) {
				log.line(
					`⚠️ ${bind}: this folder is inside the repository checkout, which is replaced on every deploy, so what the container writes there is lost. Keep data in ../files/… or a named volume.`,
				);
			}
		}
		if (!options.orphans) return;
		const listed = await host.exec(
			[
				SUDO_PREAMBLE,
				DOCKER_PREAMBLE,
				`$DOCKER volume ls --filter ${quote(projectLabel(compose))} --format '{{.Name}}\t{{.Label "com.docker.compose.volume"}}'`,
			].join("\n"),
		);
		if (listed.code !== 0) return;
		for (const name of orphanedVolumes(
			listed.output.split("\n"),
			resolvedVolumeNames(resolved),
		)) {
			log.line(
				`⚠️ Volume ${name} from an earlier deploy is no longer in the compose file: its data is kept, but this deploy does not mount it (a renamed volume, a variable in a volume name, or "Randomize names" changed).`,
			);
		}
	} catch {
		// Only hints; they never fail a deploy.
	}
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
		// runtimeGuard lines, run first in both scripts.
		guard: string[];
	},
) => {
	const { compose } = input;
	const script = (lines: string[]) =>
		[
			SUDO_PREAMBLE,
			DOCKER_PREAMBLE,
			"set -e",
			`cd ${quote(layout.code)}`,
			...steps.guard,
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

// A trusted start runs with host privileges, so it must not run anything a
// container could have written: it runs the snapshot of the last deploy
// that succeeded, from the agent's state folder. A service last deployed by
// an older agent has none: a raw one is rendered from the file the panel
// keeps, a git one has to be deployed again.
export const trustedStartSnapshot = async (
	host: Host,
	input: ComposeJobInput,
	layout: ComposeLayout,
): Promise<Snapshot> => {
	const { compose } = input;
	const file = deployedFile(input, layout);
	const deployed = await readContained(host, layout.state, file);
	if (deployed !== null) {
		if (compose.composeType === "stack") {
			return {
				file,
				text: deployed,
				spec: await stackChecks(host, input, layout, file),
			};
		}
		try {
			return {
				file,
				text: deployed,
				spec: JSON.parse(deployed) as ComposeSpec,
			};
		} catch {
			throw new Error(
				"The snapshot of the last deploy is unreadable; deploy the service again",
			);
		}
	}
	if (compose.sourceType !== "raw" || input.composeFile === null) {
		throw new Error(
			"Deploy once to start: this service has no deploy snapshot from this version of Panara Cloud, and starting it would run files its containers can change",
		);
	}
	const rendered = renderCompose(input.composeFile, input).yaml;
	return await trustedSnapshot(
		host,
		input,
		layout,
		rendered,
		sourceLookup(input, layout, [], null, rendered),
	);
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
	// The file in code/ is container-writable: an untrusted start checks it
	// again, a trusted one never reads it.
	const snapshot = input.trusted
		? await trustedStartSnapshot(host, input, layout)
		: await resolveUntrusted(host, input, layout);
	if (input.trusted) assertNoProtectedBinds(snapshot.spec, layout.base);
	const args = startArgs(input, snapshot.file);
	const lines = [
		"set -e",
		`cd ${quote(layout.code)}`,
		...runtimeGuard(hostPaths(snapshot.spec), layout.base),
	];
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

// The source of the service's last deploy, as the agent recorded it. A
// service last deployed by an older agent has no record: a real `.git`
// folder in code/ (never a symlink) marks a checkout there.
const removalSource = async (
	host: Host,
	layout: ComposeLayout,
): Promise<"raw" | "git"> => {
	const recorded = await previousSource(host, layout);
	if (recorded) return recorded;
	const git = quote(`${layout.code}/.git`);
	const check = `[ -d ${git} ] && [ ! -L ${git} ]`;
	const result = await host.exec(
		`if ${check}; then echo git; elif sudo -n sh -c ${quote(check)} 2>/dev/null; then echo git; else echo raw; fi`,
	);
	return result.output.trim() === "git" ? "git" : "raw";
};

// Removes a compose: tears the project down and deletes its directory,
// isolated network and the images it built that nothing else uses
// (images.ts). With `deleteVolumes` and `checks`, its own volumes go too
// unless something else still uses them (the outcome says which were kept).
// Without `checks` (a transfer dropping the source copy) they are removed as
// Docker allows. Safe to repeat. The job carries no source type (its stored
// shape stays the one older releases accept): the agent's own record says.
export const removeCompose = async (
	host: Host,
	target: {
		appName: string;
		composeType: ComposeType;
		deleteVolumes: boolean;
	},
	log: ComposeLog,
	options: { signal?: AbortSignal; checks?: VolumeChecks } = {},
): Promise<VolumeOutcome> => {
	const { signal, checks } = options;
	// Raw compose files are always code/docker-compose.yml; a git checkout
	// goes as a whole, whatever its compose path.
	const layout = composeLayout({
		appName: target.appName,
		sourceType: "raw",
		composePath: "docker-compose.yml",
	});
	const sourceType = target.deleteVolumes
		? "raw"
		: await removalSource(host, layout);
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
	await removeHostPath(host, layout.state, { recursive: true });
	if (target.deleteVolumes) {
		await removeHostPath(host, layout.base, { recursive: true });
		log.line(`Removed ${layout.base}`);
	} else {
		// Kept like the volumes: files/ and what `./` bind mounts of a raw
		// compose wrote in code/. Gone: a git checkout (it is replaced on
		// every deploy anyway), the compose file and the .env with secrets.
		if (sourceType === "git") {
			await removeHostPath(host, layout.code, { recursive: true });
		} else {
			await removeHostPath(host, layout.envFile);
			await removeHostPath(host, layout.composeFile);
		}
		log.line(
			`Kept ${layout.base}: data the containers wrote through bind mounts stays there, like the volumes`,
		);
	}
	return outcome;
};
