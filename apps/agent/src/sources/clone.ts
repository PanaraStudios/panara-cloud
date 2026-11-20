import { posix } from "node:path";
import type { Host } from "../host/types";
import { paths } from "../lib/constants";
import { quote } from "../lib/shell";
import { redact } from "./redact";

// Matches CloneCredentials in packages/backend/convex/sources/agent.ts.
export type CloneCredentials =
	| { type: "basic"; username: string; password: string }
	| { type: "ssh"; privateKey: string };

export type CloneOptions = {
	// Must not contain credentials; pass them in `credentials`.
	url: string;
	branch: string;
	credentials?: CloneCredentials | null;
	submodules?: boolean;
	// History depth; 0 clones everything. Defaults to 1.
	depth?: number;
	// Absolute path; replaced if it exists.
	dest: string;
	// SSH host keys are trusted on first use and remembered here. Falls back
	// to ~/.ssh/known_hosts when the default isn't writable.
	knownHostsPath?: string;
	signal?: AbortSignal;
};

export type CloneLog = {
	line: (text: string) => void;
	append: (text: string) => void;
};

export type CloneResult = { commitSha: string; commitMessage: string };

const COMMIT_MARKER = "---PANARA-COMMIT---";

// Repositories are untrusted: a committed symlink to /etc/shadow or
// /root/.ssh would make later agent reads and writes inside the checkout
// (compose file, .env, builders) touch host files. Links that resolve inside
// the checkout keep working.
export const removeEscapingSymlinks = (dir: string) =>
	[
		`real_dir="$(cd ${dir} && pwd -P)"`,
		`find ${dir} -type l -print0 | while IFS= read -r -d '' link; do`,
		// BSD realpath (macOS) has no -m; readlink -f resolves the same way there.
		'  target="$(realpath -m -- "$link" 2>/dev/null || readlink -f -- "$link")"',
		'  case "$target/" in "$real_dir/"*) continue ;; esac',
		'  rm -f -- "$link"',
		`  printf 'Removed symlink %s: it points outside the repository\\n' "$link"`,
		"done",
	].join("\n");

const assertDest = (dest: string) => {
	const normalized = posix.normalize(dest);
	if (
		!posix.isAbsolute(dest) ||
		normalized !== dest.replace(/\/+$/, "") ||
		normalized.split("/").filter(Boolean).length < 2
	) {
		throw new Error(`Refusing to clone into ${dest}`);
	}
	return normalized;
};

// Repositories (and their submodules) only come over the network: local
// paths, file:// and ext:: would read or run anything on the host. Plain
// http is allowed only when the source itself is configured with it (e.g.
// a self-hosted Gitea on an internal URL).
export const allowedProtocols = (url: string) =>
	/^http:\/\//i.test(url.trim()) ? "https:ssh:http" : "https:ssh";

// Secrets reach the host on stdin, never in the command line (visible in
// `ps`) or the clone URL (persisted in .git/config). Basic credentials are
// served by a credential helper reading environment variables; `git -c`
// options apply to submodule clones too but are not written to the
// repository's config. SSH keys go to a private temp dir removed on exit.
export const buildCloneScript = (options: CloneOptions): string => {
	const dest = assertDest(options.dest);
	const depth = options.depth ?? 1;
	const credentials = options.credentials ?? null;
	const gitConfig = ["-c credential.helper=", "-c protocol.file.allow=never"];
	const setup: string[] = [];

	if (credentials?.type === "basic") {
		setup.push(
			"IFS= read -r PANARA_CLOUD_GIT_USERNAME || true",
			"IFS= read -r PANARA_CLOUD_GIT_PASSWORD || true",
			"export PANARA_CLOUD_GIT_USERNAME PANARA_CLOUD_GIT_PASSWORD",
			`helper='!f() { test "$1" = get || exit 0; printf "username=%s\\npassword=%s\\n" "$PANARA_CLOUD_GIT_USERNAME" "$PANARA_CLOUD_GIT_PASSWORD"; }; f'`,
		);
		gitConfig.push('-c "credential.helper=$helper"');
	} else if (credentials?.type === "ssh") {
		const knownHosts = quote(
			options.knownHostsPath ?? `${paths.ssh}/known_hosts`,
		);
		setup.push(
			"IFS= read -r PANARA_CLOUD_SSH_KEY || true",
			'printf %s "$PANARA_CLOUD_SSH_KEY" | base64 -d > "$tmp/key"',
			"unset PANARA_CLOUD_SSH_KEY",
			'chmod 600 "$tmp/key"',
			`known_hosts=${knownHosts}`,
			'if ! { mkdir -p "$(dirname "$known_hosts")" && touch "$known_hosts"; } 2>/dev/null; then known_hosts="$HOME/.ssh/known_hosts"; mkdir -p "$HOME/.ssh"; touch "$known_hosts"; fi',
			'export GIT_SSH_COMMAND="ssh -i $(printf %q "$tmp/key") -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile=$(printf %q "$known_hosts") -o StrictHostKeyChecking=accept-new"',
		);
	}

	const cloneArgs = [
		"clone",
		"--progress",
		"--branch",
		quote(options.branch),
		...(depth > 0 ? ["--depth", String(Math.floor(depth))] : []),
		...(options.submodules ? ["--recurse-submodules"] : []),
		"--",
		quote(options.url),
		'"$dest"',
	];

	return [
		"set -eo pipefail",
		"export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true SSH_ASKPASS=true",
		`export GIT_ALLOW_PROTOCOL=${allowedProtocols(options.url)}`,
		'tmp="$(mktemp -d)"',
		"trap 'rm -rf \"$tmp\"' EXIT",
		`dest=${quote(dest)}`,
		...setup,
		'rm -rf -- "$dest"',
		'mkdir -p -- "$(dirname -- "$dest")"',
		`git ${gitConfig.join(" ")} ${cloneArgs.join(" ")}`,
		removeEscapingSymlinks('"$dest"'),
		`printf '%s\\n' ${quote(COMMIT_MARKER)}`,
		`git -C "$dest" log -1 --format='%H%n%B'`,
	].join("\n");
};

const stdinFor = (credentials: CloneCredentials | null | undefined) => {
	if (credentials?.type === "basic") {
		if (/[\r\n]/.test(credentials.username + credentials.password)) {
			throw new Error("Git credentials must not contain newlines");
		}
		return `${credentials.username}\n${credentials.password}\n`;
	}
	if (credentials?.type === "ssh") {
		const key = credentials.privateKey.endsWith("\n")
			? credentials.privateKey
			: `${credentials.privateKey}\n`;
		return `${Buffer.from(key).toString("base64")}\n`;
	}
	return "";
};

const secretsOf = (credentials: CloneCredentials | null | undefined) =>
	credentials?.type === "basic"
		? [credentials.password]
		: credentials?.type === "ssh"
			? [
					credentials.privateKey,
					Buffer.from(credentials.privateKey).toString("base64"),
				]
			: [];

// Clones `url` at `branch` into `dest` on the host and returns the checked
// out commit. Progress is streamed to `log` with credentials scrubbed.
export const cloneRepository = async (
	host: Host,
	options: CloneOptions,
	log: CloneLog,
): Promise<CloneResult> => {
	const script = buildCloneScript(options);
	const secrets = secretsOf(options.credentials);
	log.line(
		`Cloning ${redact(options.url)} (${options.branch}) to ${options.dest}`,
	);
	let output = "";
	let markerSeen = false;
	const result = await host.exec(script, {
		input: stdinFor(options.credentials),
		signal: options.signal,
		onOutput: (text) => {
			if (markerSeen) return;
			output += text;
			const at = output.indexOf(COMMIT_MARKER);
			if (at === -1) {
				log.append(redact(text, secrets));
				return;
			}
			markerSeen = true;
			const before = text.slice(
				0,
				Math.max(0, text.length - (output.length - at)),
			);
			if (before) log.append(redact(before, secrets));
		},
	});
	const markerAt = result.output.indexOf(COMMIT_MARKER);
	if (result.code !== 0 || markerAt === -1) {
		const tail = redact(result.output, secrets)
			.trim()
			.split("\n")
			.slice(-5)
			.join("\n");
		throw new Error(
			`git clone of ${redact(options.url)} failed (exit ${result.code})${tail ? `: ${tail}` : ""}`,
		);
	}
	const [commitSha = "", ...message] = result.output
		.slice(markerAt + COMMIT_MARKER.length)
		.replace(/^\r?\n/, "")
		.split("\n");
	log.line(`Cloned commit ${commitSha.trim()}`);
	return {
		commitSha: commitSha.trim(),
		commitMessage: message.join("\n").trim(),
	};
};
