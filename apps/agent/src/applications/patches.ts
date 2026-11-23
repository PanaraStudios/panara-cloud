import { posix } from "node:path";
import type { Host } from "../host/types";
import { quote } from "../lib/shell";
import { encodeBase64, symlinkGuard } from "./builders/utils";
import { within } from "./paths";
import { type BuildLog, runScript } from "./process";

// Matches PatchForBuild in packages/backend/convex/applications/patches.ts.
export type Patch = {
	filePath: string;
	type: "create" | "update" | "delete";
	content: string;
};

// Script that applies patches: write (or delete) each file inside
// `repoDir`, refusing paths that escape it directly or through symlinks.
export const buildPatchScript = (repoDir: string, patches: Patch[]): string => {
	if (patches.length === 0) return "";
	let script = `set -e\necho ${quote(`Applying ${patches.length} patch(es)...`)}\n`;
	for (const patch of patches) {
		const file = within(repoDir, patch.filePath);
		if (file === posix.normalize(repoDir)) {
			throw new Error(`Invalid patch path: ${patch.filePath}`);
		}
		script += symlinkGuard(repoDir, file);
		if (patch.type === "delete") {
			script += `rm -f ${quote(file)}\n`;
		} else {
			script += `mkdir -p ${quote(posix.dirname(file))}\n`;
			script += `echo ${quote(encodeBase64(patch.content))} | base64 -d > ${quote(file)}\n`;
		}
		script += `echo ${quote(`  ${patch.type} ${patch.filePath}`)}\n`;
	}
	return script;
};

// Applies patches to a checked-out repository on the host. Compose can use
// this with its own code directory.
export const applyPatches = async (
	host: Host,
	repoDir: string,
	patches: Patch[],
	log: BuildLog,
	signal?: AbortSignal,
): Promise<void> => {
	const script = buildPatchScript(repoDir, patches);
	if (!script) return;
	await runScript(host, script, { log, signal });
};
