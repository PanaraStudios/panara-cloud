import { randomUUID } from "node:crypto";
import type { Host } from "../host/types";
import { quote } from "../lib/shell";

export type BuildLog = {
	line: (text: string) => void;
	append: (text: string) => void;
};

const KILL_GRACE_MS = 5_000;

export class CancelledError extends Error {
	constructor() {
		super("Cancelled");
	}
}

// Runs a bash script in its own process group (via setsid) so cancelling
// kills exactly this script and everything it spawned (docker build,
// nixpacks, pack, ...) and nothing else on the host. The script travels on
// stdin, so values exported inside it never show up in `ps`.
// Without setsid the script shares the launcher's group and cancelling
// falls back to killing only the script's own process.
export const runScript = async (
	host: Host,
	script: string,
	options: { log: BuildLog; signal?: AbortSignal; secrets?: string[] },
): Promise<string> => {
	if (options.signal?.aborted) throw new CancelledError();
	const pidFile = `/tmp/panara-cloud-build-${randomUUID()}.pid`;
	const scrub = (text: string) => {
		let result = text;
		for (const secret of options.secrets ?? []) {
			if (secret.length >= 4) result = result.split(secret).join("***");
		}
		return result;
	};
	// The script is copied to a private temp file first so commands inside it
	// that read stdin can't consume the rest of the script.
	const launcher = [
		`pidfile=${quote(pidFile)}`,
		'script="$(mktemp)"',
		'cat > "$script"',
		"if command -v setsid >/dev/null 2>&1; then",
		`  setsid -w bash -c 'echo $$ > "$0"; exec bash "$1" </dev/null' "$pidfile" "$script"`,
		"else",
		`  bash -c 'echo $$ > "$0"; exec bash "$1" </dev/null' "$pidfile" "$script"`,
		"fi",
		"code=$?",
		'rm -f "$pidfile" "$script"',
		"exit $code",
	].join("\n");

	let cancelled = false;
	const onAbort = () => {
		cancelled = true;
		const kill = `pg=$(cat ${quote(pidFile)} 2>/dev/null) && [ -n "$pg" ] && { kill -TERM -- "-$pg" 2>/dev/null || kill -TERM "$pg"; sleep ${KILL_GRACE_MS / 1000}; kill -KILL -- "-$pg" 2>/dev/null || kill -KILL "$pg" 2>/dev/null; }; true`;
		void host.exec(kill).catch(() => {});
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const result = await host.exec(launcher, {
			input: script.endsWith("\n") ? script : `${script}\n`,
			onOutput: (text) => options.log.append(scrub(text)),
		});
		// A script that ended with 0 ran to its end: a cancel that came while it
		// finished stopped nothing, and what it did is done (the compose project
		// is up). A script the cancel killed never ends with 0.
		if (result.code === 0) return result.output;
		if (cancelled || options.signal?.aborted) throw new CancelledError();
		const tail = scrub(result.output)
			.trim()
			.split("\n")
			.filter(Boolean)
			.slice(-3)
			.join("\n");
		throw new Error(tail || `Script failed with exit code ${result.code}`);
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
	}
};
