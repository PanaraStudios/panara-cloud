import type { ExecOptions, Host } from "../host/types";
import { HostCommandError } from "../host/types";
import { quote } from "../lib/shell";

// Lets scripts run privileged commands as `$SUDO ...` for both root and
// passwordless-sudo users.
export const SUDO_PREAMBLE = `SUDO=""; if [ "$(id -u)" -ne 0 ]; then SUDO="sudo -n"; fi`;

// `$DOCKER` works for root, docker-group members and sudo users alike.
export const DOCKER_PREAMBLE = `DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="$SUDO docker"`;

export const toBase64 = (content: string): string =>
	Buffer.from(content, "utf8").toString("base64");

export const fromBase64 = (value: string | undefined): string => {
	if (!value) return "";
	try {
		return Buffer.from(value, "base64").toString("utf8");
	} catch {
		return "";
	}
};

// Runs a script with sudo available as $SUDO and reports the last line of
// output on failure, which is where the scripts print their reason.
export const runScript = async (
	host: Host,
	script: string,
	options?: ExecOptions,
): Promise<string> => {
	const result = await host.exec(
		`${SUDO_PREAMBLE}\n${DOCKER_PREAMBLE}\n${script}`,
		options,
	);
	if (result.code !== 0) {
		const reason = result.output.trim().split("\n").filter(Boolean).at(-1);
		throw reason
			? new Error(reason)
			: new HostCommandError(script, result.code, result.output);
	}
	return result.output;
};

// Scripts print `<<name` markers so one round trip can return several lists.
export const splitSections = (output: string): Record<string, string[]> => {
	const sections: Record<string, string[]> = {};
	let current = "";
	for (const line of output.split("\n")) {
		const marker = line.match(/^<<(\w+)$/);
		if (marker?.[1]) {
			current = marker[1];
			sections[current] = [];
			continue;
		}
		if (current && line.trim()) sections[current]?.push(line);
	}
	return sections;
};

export const keyValues = (
	lines: string[] | undefined,
): Record<string, string> =>
	Object.fromEntries(
		(lines ?? []).map((line) => {
			const index = line.indexOf("=");
			return index === -1
				? [line, ""]
				: [line.slice(0, index), line.slice(index + 1)];
		}),
	);

// Host.writeFile handles sudo for writes; removals need the same fallback.
export const removeHostPath = async (
	host: Host,
	path: string,
	options: { recursive?: boolean } = {},
): Promise<void> => {
	const rm = `rm -${options.recursive ? "rf" : "f"} ${quote(path)}`;
	await host.run(`${rm} 2>/dev/null || sudo -n ${rm}`);
};
