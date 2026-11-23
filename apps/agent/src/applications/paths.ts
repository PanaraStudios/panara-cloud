import { posix } from "node:path";
import { paths } from "../lib/constants";

const SAFE_APP_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const BUILD_PATH = /^([a-zA-Z0-9._@+/][a-zA-Z0-9._@+/-]*)?$/;
const BUILD_TOKEN = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)?$/;

export const assertAppName = (appName: string): string => {
	if (!SAFE_APP_NAME.test(appName))
		throw new Error(`Invalid appName: ${appName}`);
	return appName;
};

export const isSafeBuildPath = (value: string) =>
	BUILD_PATH.test(value) && !value.split("/").includes("..");

export const assertBuildPath = (value: string | undefined, field: string) => {
	if (value && !isSafeBuildPath(value)) {
		throw new Error(`Invalid ${field}: ${value}`);
	}
};

export const assertBuildToken = (value: string | undefined, field: string) => {
	if (value && !BUILD_TOKEN.test(value)) {
		throw new Error(`Invalid ${field}: ${value}`);
	}
};

export const appDir = (appName: string) =>
	`${paths.applications}/${assertAppName(appName)}`;

export const codeDir = (appName: string) => `${appDir(appName)}/code`;

export const patchRepoDir = (kind: string, appName: string) =>
	`${paths.patchRepos}/${kind}/${assertAppName(appName)}`;

// Joins relative segments under `base` and refuses anything that escapes it.
export const within = (base: string, ...segments: string[]): string => {
	const joined = posix.normalize(
		posix.join(base, ...segments.map((s) => s.replace(/^\/+/, ""))),
	);
	const normalizedBase = posix.normalize(base).replace(/\/+$/, "");
	if (joined !== normalizedBase && !joined.startsWith(`${normalizedBase}/`)) {
		throw new Error(`Path escapes ${base}: ${segments.join("/")}`);
	}
	return joined.replace(/\/+$/, "") || "/";
};
