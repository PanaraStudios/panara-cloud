import { posix } from "node:path";
import type { Host } from "../host/types";
import { quote } from "../lib/shell";
import { within } from "./paths";

export type RepoEntry = {
	name: string;
	path: string;
	type: "file" | "directory";
	children?: RepoEntry[];
};

const MAX_FILES = 20_000;

// The patch repository's file tree, built from `git ls-tree` output.
export const buildRepoTree = (files: string[]): RepoEntry[] => {
	const root: RepoEntry[] = [];
	const dirs = new Map<string, RepoEntry>();
	for (const file of files.slice(0, MAX_FILES)) {
		const parts = file.split("/").filter(Boolean);
		let current = "";
		parts.forEach((part, index) => {
			const parent = current;
			current = current ? `${current}/${part}` : part;
			if (dirs.has(current)) return;
			const isFile = index === parts.length - 1;
			const entry: RepoEntry = {
				name: part,
				path: current,
				type: isFile ? "file" : "directory",
				...(isFile ? {} : { children: [] }),
			};
			dirs.set(current, entry);
			if (parent) dirs.get(parent)?.children?.push(entry);
			else root.push(entry);
		});
	}
	return root;
};

export const listRepoTree = async (host: Host, repoDir: string) => {
	const output = await host.run(
		`git -C ${quote(repoDir)} ls-tree -r --name-only HEAD`,
	);
	return buildRepoTree(
		output
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean),
	);
};

// Reads from the git tree, not the working copy, so symlinks committed to the
// repository can't expose host files.
export const readRepoFile = async (
	host: Host,
	repoDir: string,
	filePath: string,
) => {
	const full = within(repoDir, filePath);
	const relative = posix.relative(posix.normalize(repoDir), full);
	if (!relative || relative.startsWith("..")) {
		throw new Error("Invalid file path");
	}
	return await host.run(
		`git -C ${quote(repoDir)} cat-file --filters ${quote(`HEAD:${relative}`)}`,
	);
};
