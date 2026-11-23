import type { ExecOptions, Host } from "../host/types";
import { quote } from "../lib/shell";
import { redact } from "../sources/redact";

// Scripts arrive on stdin and run from a private temp file, so credentials
// exported inside them never show up in a process's argv on the host.
const runnerCommand = [
	'f=$(mktemp "${TMPDIR:-/tmp}/panara-cloud-db-XXXXXX")',
	"trap 'rm -f \"$f\"' EXIT",
	'cat > "$f"',
	'chmod 700 "$f"',
	'bash "$f" </dev/null',
].join("\n");

export class ScriptError extends Error {
	constructor(
		message: string,
		readonly code: number | null,
		readonly output: string,
	) {
		super(message);
	}
}

export const exportLine = (name: string, value: string) =>
	`export ${name}=${quote(value)}`;

export type ScriptOptions = Pick<ExecOptions, "onOutput" | "signal"> & {
	// Masked in streamed output and errors.
	secrets?: (string | undefined)[];
};

export const runHostScript = async (
	host: Host,
	script: string,
	options: ScriptOptions = {},
): Promise<string> => {
	const secrets = options.secrets ?? [];
	const result = await host.exec(runnerCommand, {
		input: `set -eo pipefail\n${script}\n`,
		signal: options.signal,
		onOutput: options.onOutput
			? (text) => options.onOutput?.(redact(text, secrets))
			: undefined,
	});
	const output = redact(result.output, secrets);
	if (result.code !== 0) {
		const reason = output.trim().split("\n").filter(Boolean).at(-1);
		throw new ScriptError(
			reason ?? `Script failed with exit code ${result.code}`,
			result.code,
			output,
		);
	}
	return output;
};
