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
	// Untransformed copy of the source compose file, so redeploys without a
	// fresh clone don't transform twice.
	pristineFile: string;
	// Where older agents kept the pristine copy.
	legacyPristineFile: string;
	stackEnvFile: string;
	// Interpolation variables for `docker compose config` of stacks.
	configEnvFile: string;
	// The checked `docker compose config` output untrusted deploys run.
	resolvedFile: string;
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
		pristineFile: `${state}/source.yml`,
		legacyPristineFile: `${base}/source.yml`,
		stackEnvFile: `${state}/stack.env`,
		configEnvFile: `${state}/config.env`,
		resolvedFile: `${state}/compose.json`,
	};
};

// Validates a custom compose command: no shell metacharacters; `&&` only chains
// further docker compose commands. Returns the command without `docker`.
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

// The deploy command; arguments after `docker`.
export const deployCommand = (
	input: CommandInput,
	layout: ComposeLayout,
): string => {
	if (input.command.trim()) return sanitizeCommand(input.command);
	if (input.composeType === "stack") {
		return `stack deploy -c ${quote(layout.composeFileRelative)} ${quote(input.appName)} --prune --with-registry-auth`;
	}
	return `compose ${composeFlags(input, layout)} up -d --build --remove-orphans${input.pullImages ? " --pull always" : ""}`;
};

export const startCommand = (
	input: CommandInput,
	layout: ComposeLayout,
): string => `compose ${composeFlags(input, layout)} up -d`;

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
