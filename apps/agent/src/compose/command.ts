import { posix } from "node:path";
import { paths } from "../lib/constants";
import { envForFile, prepareEnvironmentVariables } from "../lib/env";
import { quote } from "../lib/shell";
import type { ComposeType } from "./transforms";

const APP_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const UNSAFE_COMMAND = /[;|`$(){}<>\n\\]/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ComposeLayout = {
	base: string;
	code: string;
	files: string;
	// The compose file docker runs, inside `code`.
	composeFile: string;
	// The same file relative to `code` (the working directory of commands).
	composeFileRelative: string;
	envFile: string;
	envFileRelative: string;
	// Agent-only files, outside `base` because containers may bind and
	// rewrite anything under it.
	state: string;
	// Where a git source is cloned before it replaces `code`, out of the
	// containers' reach.
	checkout: string;
	// The commit's copies of the compose file and of the files it pulls in
	// (include, extends, label_file, env files), by path relative to `code`,
	// taken from the clone before any container could change them. A
	// redeploy without a fresh clone reads them again.
	capture: string;
	// Where older agents kept the untransformed compose file: in `base`, so
	// a container could have rewritten it. Removed, never read.
	legacyPristineFile: string;
	// Files of earlier versions of this agent in `state`, removed on deploy.
	obsoleteFiles: string[];
	// What `docker compose config` of a trusted deploy reads: the host's
	// paths under this folder (`<mirror>/etc/panara-cloud/compose/<app>/…`),
	// so relative paths resolve exactly as they do in `base`.
	mirror: string;
	// Interpolation variables when the service has no env file.
	emptyEnvFile: string;
	stackEnvFile: string;
	// Interpolation variables for `docker compose config` of stacks.
	configEnvFile: string;
	// The snapshot a compose deploy runs: `docker compose config` output.
	resolvedFile: string;
	// The snapshot a trusted stack deploy runs: the rendered YAML.
	stackFile: string;
	// The snapshots of the last deploy that succeeded, which Start runs.
	deployedFile: string;
	deployedStackFile: string;
};

export const assertAppName = (appName: string) => {
	if (!APP_NAME.test(appName)) throw new Error(`Invalid appName: ${appName}`);
	return appName;
};

export const composeLayout = (input: {
	appName: string;
	sourceType: "raw" | "git";
	composePath: string;
}): ComposeLayout => {
	const base = `${paths.compose}/${assertAppName(input.appName)}`;
	const code = `${base}/code`;
	const relative = posix.normalize(
		input.sourceType === "raw" ? "docker-compose.yml" : input.composePath,
	);
	const composeFile = posix.join(code, relative);
	if (
		posix.isAbsolute(relative) ||
		relative.startsWith("../") ||
		!composeFile.startsWith(`${code}/`)
	) {
		throw new Error("Invalid compose path");
	}
	const composeFileRelative = posix.relative(code, composeFile);
	const envFileRelative = posix.join(
		posix.dirname(composeFileRelative),
		".env",
	);
	const state = `${paths.composeState}/${input.appName}`;
	return {
		base,
		code,
		state,
		files: `${base}/files`,
		composeFile,
		composeFileRelative,
		envFile: posix.join(code, envFileRelative),
		envFileRelative,
		checkout: `${state}/checkout`,
		capture: `${state}/repo`,
		legacyPristineFile: `${base}/source.yml`,
		obsoleteFiles: [`${state}/source.yml`, `${state}/rendered.yml`],
		mirror: `${state}/root`,
		emptyEnvFile: `${state}/empty.env`,
		stackEnvFile: `${state}/stack.env`,
		configEnvFile: `${state}/config.env`,
		resolvedFile: `${state}/compose.json`,
		stackFile: `${state}/stack.yml`,
		deployedFile: `${state}/deployed.json`,
		deployedStackFile: `${state}/deployed-stack.yml`,
	};
};

// Validates a custom compose command: no shell metacharacters; `&&` only chains
// further docker compose commands. Returns the command without `docker`: the
// panel shows its default as "docker compose -p …", so a command written the
// same way loses the word here instead of running as `docker docker compose`.
export const sanitizeCommand = (command: string): string => {
	const value = command.trim();
	if (UNSAFE_COMMAND.test(value)) {
		throw new Error(
			"Invalid characters in compose command: shell control characters are not allowed",
		);
	}
	if (value.includes("&")) {
		if (/(?<!&)&(?!&)/.test(value) || value.includes("&&&")) {
			throw new Error("Single '&' is not allowed. Use '&&' for chaining.");
		}
		const chained = value
			.split("&&")
			.slice(1)
			.map((part) => part.trim());
		if (
			!chained.every(
				(part) =>
					part.startsWith("docker compose ") ||
					part.startsWith("docker-compose "),
			)
		) {
			throw new Error(
				"Chained commands must strictly start with 'docker compose '",
			);
		}
	}
	return value
		.replace(/^docker\s+/, "")
		.split(/\s+/)
		.map((arg) => arg.replace(/^"(.*)"$/, "$1"))
		.join(" ");
};

export type CommandInput = {
	appName: string;
	composeType: ComposeType;
	command: string;
	createEnvFile: boolean;
	pullImages: boolean;
	hasMounts: boolean;
};

export const composeFlags = (input: CommandInput, layout: ComposeLayout) =>
	[
		"-p",
		quote(input.appName),
		...(input.hasMounts ? ["--project-directory", quote(layout.code)] : []),
		...(input.createEnvFile
			? ["--env-file", quote(layout.envFileRelative)]
			: []),
		"-f",
		quote(layout.composeFileRelative),
	].join(" ");

export type ComposeVersion = readonly [number, number, number];

// `docker compose version --short`: "2.40.3", "v2.20.3" or "5.6.0".
export const parseComposeVersion = (output: string): ComposeVersion | null => {
	const match = output.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

const atLeast = (
	version: ComposeVersion | null,
	major: number,
	minor: number,
) =>
	version !== null &&
	(version[0] > major || (version[0] === major && version[1] >= minor));

// A deploy pulls and builds before `up`, while a cancel can still stop it,
// and `up` must not do either again: it used to pull every image a second
// time with "pull images" and run every `no_cache` build twice.
// `pull` is what runs before the build, after the project's flags; `up` is
// what `up -d --remove-orphans` takes.
export type ComposePlan = {
	pull: { args: string; mayFail: boolean } | null;
	up: string;
};

export const composePlan = (
	pullImages: boolean,
	version: ComposeVersion | null,
): ComposePlan => {
	if (pullImages) {
		// `--ignore-buildable` (2.15) leaves out the images `build` makes, whose
		// names often exist in no registry, so the pull can be strict: once it
		// succeeds every other image is fresh and `up` pulls nothing, not even
		// a service's own `pull_policy: always`. A pull that fails stops the
		// deploy before any container is touched.
		if (atLeast(version, 2, 15)) {
			return {
				pull: { args: "pull --ignore-buildable", mayFail: false },
				up: "--no-build --pull never",
			};
		}
		return {
			pull: { args: "pull --ignore-pull-failures", mayFail: true },
			up: "--no-build --pull always",
		};
	}
	// `--policy missing` (2.22) pulls what `up` would; `up` then finds the
	// images present and tries again only those that failed, reporting why.
	// Older versions leave the pulls to `up`.
	return {
		pull: atLeast(version, 2, 22)
			? { args: "pull --ignore-pull-failures --policy missing", mayFail: true }
			: null,
		up: "--no-build",
	};
};

export const upArgs = (pullImages: boolean, plan?: ComposePlan) =>
	plan
		? `up -d --remove-orphans ${plan.up}`
		: `up -d --build --remove-orphans${pullImages ? " --pull always" : ""}`;

// The compose .env content: APP_NAME and
// COMPOSE_PROJECT_NAME first, then the service env with project /
// environment references resolved; COMPOSE_PREFIX when randomized.
export const composeEnvPairs = (input: {
	appName: string;
	env: string;
	projectEnv: string;
	environmentEnv: string;
	randomize: boolean;
	suffix: string;
}): string[] => {
	let content = `APP_NAME=${input.appName}\nCOMPOSE_PROJECT_NAME=${input.appName}\n${input.env}`;
	if (input.randomize && input.suffix) {
		content += `\nCOMPOSE_PREFIX=${input.suffix}`;
	}
	return prepareEnvironmentVariables(
		content,
		input.projectEnv,
		input.environmentEnv,
	);
};

// docker compose reads .env with its own escaping; `docker stack deploy`
// doesn't read it at all, so stacks get raw, unescaped values
// and the variables are exported from a sourced file instead.
export const envFileContent = (pairs: string[], composeType: ComposeType) =>
	`${(composeType === "stack" ? pairs : envForFile(pairs)).join("\n")}\n`;

export const shellEnvContent = (pairs: string[]) =>
	`${pairs
		.map((pair) => {
			const index = pair.indexOf("=");
			const key = pair.slice(0, index);
			if (!ENV_KEY.test(key)) return null;
			return `export ${key}=${quote(pair.slice(index + 1))}`;
		})
		.filter((line) => line !== null)
		.join("\n")}\n`;
