import { posix } from "node:path";
import type { Host } from "../host/types";
import { paths } from "../lib/constants";
import { quote } from "../lib/shell";

const APP_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
// Matches the size of a file mount's content stored in Convex.
export const MAX_MOUNT_FILE_BYTES = 512 * 1024;
const FOUND = "found:";

export type MountFileInput = {
	// applications and databases write under applications/, compose under
	// compose/ (apps/agent/src/lib/swarm.ts, apps/agent/src/compose/host.ts).
	base: "applications" | "compose";
	appName: string;
	filePath: string;
};

export type MountFileOnHost =
	| { found: false }
	| { found: true; tooLarge: true }
	| { found: true; content: string };

export const mountFileLocation = (input: MountFileInput) => {
	if (!APP_NAME.test(input.appName)) {
		throw new Error(`Invalid appName: ${input.appName}`);
	}
	const relative = posix.normalize(input.filePath);
	if (
		!relative ||
		relative === "." ||
		posix.isAbsolute(relative) ||
		relative === ".." ||
		relative.startsWith("../")
	) {
		throw new Error(`Invalid file mount path: ${input.filePath}`);
	}
	const dir = `${paths[input.base]}/${input.appName}/files`;
	return { dir, path: posix.join(dir, relative) };
};

// Opens the leaf without following a symlink and only if it is a regular
// file (a container could plant a FIFO or a device node), then hands the
// already-checked descriptor to head.
const OPEN_REGULAR_FILE = `use Fcntl; sysopen(my $f, $ARGV[0], O_RDONLY|O_NOFOLLOW|O_NONBLOCK) or exit 3; -f $f or exit 3; open(STDIN, "<&", $f) or exit 3; exec "head", "-c", $ARGV[1]`;

// Reads a file mount's content. Containers of the service can write to its
// files directory (and replace it, or any directory below it, with a
// symlink), so the walk starts from the service directory the agent owns,
// cds one component at a time and then checks the real working directory:
// the shell's cwd is pinned, so a symlink swapped in afterwards can't move it.
export const readMountFileScript = (dir: string, path: string) => {
	const parent = posix.dirname(dir);
	const components = posix.relative(parent, path).split("/");
	const leaf = components.pop() ?? "";
	const expected = components.join("/");
	return [
		"set -o pipefail",
		`anchor=$(realpath -- ${quote(parent)} 2>/dev/null) || exit 0`,
		'cd -P -- "$anchor" 2>/dev/null || exit 0',
		...components.map(
			(component) => `cd -P -- ${quote(component)} 2>/dev/null || exit 0`,
		),
		`[ "$(pwd -P)" = "$anchor"/${quote(expected)} ] || exit 0`,
		`data=$(perl -e ${quote(OPEN_REGULAR_FILE)} -- ${quote(leaf)} ${MAX_MOUNT_FILE_BYTES + 1} | base64 | tr -d '\\n') || exit 0`,
		`printf '${FOUND}%s' "$data"`,
	].join("\n");
};

export const parseMountFileOutput = (output: string): MountFileOnHost => {
	const at = output.lastIndexOf(FOUND);
	if (at === -1) return { found: false };
	const bytes = Buffer.from(output.slice(at + FOUND.length).trim(), "base64");
	if (bytes.length > MAX_MOUNT_FILE_BYTES)
		return { found: true, tooLarge: true };
	return { found: true, content: bytes.toString("utf8") };
};

export const readMountFileOnHost = async (
	host: Host,
	input: MountFileInput,
): Promise<MountFileOnHost> => {
	const { dir, path } = mountFileLocation(input);
	const result = await host.exec(readMountFileScript(dir, path));
	return parseMountFileOutput(result.output);
};
