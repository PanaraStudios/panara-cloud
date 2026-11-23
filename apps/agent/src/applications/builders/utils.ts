import { posix } from "node:path";
import { quote } from "../../lib/shell";
import { assertBuildPath, assertBuildToken, within } from "../paths";

export type BuildType =
	| "dockerfile"
	| "heroku_buildpacks"
	| "paketo_buildpacks"
	| "nixpacks"
	| "static"
	| "railpack";

// Everything a builder needs, already resolved: env values have their
// ${{project.X}} / vault references substituted.
export type BuildInput = {
	appName: string;
	// /etc/panara-cloud/applications/<appName>/code
	codeDir: string;
	buildType: BuildType;
	// Directory inside the repository ("" for the root).
	buildPath: string;
	dockerfile: string;
	dockerContextPath?: string;
	dockerBuildStage?: string;
	publishDirectory?: string;
	isStaticSpa: boolean;
	railpackVersion: string;
	herokuVersion: string;
	cleanCache: boolean;
	createEnvFile: boolean;
	// KEY=value pairs.
	env: string[];
	buildArgs: string[];
	buildSecrets: Record<string, string>;
	// Unique per build: names temporary containers and buildx builders so
	// concurrent builds never collide.
	nonce: string;
};

export const assertSafeInput = (input: BuildInput) => {
	assertBuildPath(input.buildPath, "build path");
	assertBuildPath(input.dockerfile, "Dockerfile path");
	assertBuildPath(input.dockerContextPath, "Docker context path");
	assertBuildPath(input.publishDirectory, "publish directory");
	assertBuildToken(input.dockerBuildStage, "Docker build stage");
	assertBuildToken(input.railpackVersion, "Railpack version");
	assertBuildToken(input.herokuVersion, "Heroku version");
	assertBuildToken(input.nonce, "build id");
};

// The directory non-Dockerfile builders run in.
export const appDirectory = (input: BuildInput) =>
	within(input.codeDir, input.buildPath);

export const dockerfilePath = (input: BuildInput) =>
	within(input.codeDir, input.buildPath, input.dockerfile || "Dockerfile");

export const encodeBase64 = (content: string) =>
	Buffer.from(content, "utf8").toString("base64");

// Fails the script when the directory of `fullPath` (or its nearest existing
// parent) resolves outside `basePath` through a symlink. `basePath` itself
// may sit where a container can write (a compose service's files/ or code/),
// so it must not be a symlink either: the trust root is its parent.
export const directoryGuard = (basePath: string, fullPath: string) => `
existing_dir=${quote(posix.dirname(fullPath))};
while [ ! -e "$existing_dir" ]; do existing_dir="$(dirname "$existing_dir")"; done;
real_dir="$(cd "$existing_dir" && pwd -P)";
real_base="$(cd ${quote(posix.dirname(basePath))} && pwd -P)";
real_base="\${real_base%/}"/${quote(posix.basename(basePath))};
if [ -L ${quote(basePath)} ] || [ "$(cd ${quote(basePath)} && pwd -P)" != "$real_base" ]; then echo "Path escapes its base directory" >&2; exit 1; fi;
case "$real_dir/" in "$real_base/"*) ;; *) echo "Path escapes its base directory" >&2; exit 1;; esac;
`;

// Also fails when `fullPath` itself is a symlink planted in the repository.
export const symlinkGuard = (
	basePath: string,
	fullPath: string,
) => `${directoryGuard(basePath, fullPath)}
if [ -L ${quote(fullPath)} ]; then echo "Path escapes its base directory" >&2; exit 1; fi;
`;

export const createFileCommand = (
	baseDir: string,
	filePath: string,
	content: string,
) => {
	const fullPath = within(baseDir, filePath);
	return `
mkdir -p ${quote(baseDir)};
${symlinkGuard(baseDir, fullPath)}
mkdir -p ${quote(posix.dirname(fullPath))};
if [ -d ${quote(fullPath)} ]; then rmdir ${quote(fullPath)}; fi;
echo ${quote(encodeBase64(content))} | base64 -d > ${quote(fullPath)};
`;
};

// Writes the service env as `.env` next to the Dockerfile. A `.env` symlink
// is replaced, never written through.
export const envFileCommand = (
	codeDir: string,
	directory: string,
	env: string[],
) => {
	const target = posix.join(posix.dirname(directory), ".env");
	return `${directoryGuard(codeDir, target)}rm -f ${quote(target)};
echo ${quote(encodeBase64(env.join("\n")))} | base64 -d > ${quote(target)};\n`;
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Names that change how the shell, the dynamic loader or the docker CLI
// itself behave: a member-supplied value for one of them would run code as
// the build host's user instead of reaching the build.
const HOST_CONTROL_NAME =
	/^(PATH|HOME|IFS|ENV|BASH_ENV|CDPATH|PS4|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|GLOBIGNORE|TMPDIR|SSL_CERT_FILE|SSL_CERT_DIR|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy|(LD|DYLD|DOCKER|BUILDX|BUILDKIT|XDG|BASH_FUNC)_.*)$/;

export const isHostControlName = (key: string) => HOST_CONTROL_NAME.test(key);

// Secrets reach the host inside the script (on stdin), never as arguments,
// so they don't appear in `ps`. They are exported only in a subshell that
// immediately execs the docker binary resolved before the exports, so
// nothing else in the script runs with them. Keys that aren't shell
// identifiers can't be exported and are skipped.
export const exportSecrets = (secrets: Record<string, string>) => {
	const lines: string[] = [];
	const keys: string[] = [];
	const skipped: string[] = [];
	for (const [key, value] of Object.entries(secrets)) {
		if (!IDENTIFIER.test(key) || !value) continue;
		if (isHostControlName(key)) {
			skipped.push(key);
			continue;
		}
		lines.push(`export ${key}=${quote(value)}`);
		keys.push(key);
	}
	const warning = skipped.length
		? `echo ${quote(`⚠️ Not passing ${skipped.join(", ")} to the build: these names control the build host's shell or Docker CLI`)} ;\n`
		: "";
	const docker = (args: string) =>
		`${warning}docker_bin="$(command -v docker)" || { echo "❌ docker not found" ; exit 1; }
( ${[...lines, `exec "$docker_bin" ${args}`].join("\n  ")} )`;
	return { keys, skipped, docker };
};

export const shellPairs = (pairs: string[]) => pairs.map((pair) => quote(pair));
