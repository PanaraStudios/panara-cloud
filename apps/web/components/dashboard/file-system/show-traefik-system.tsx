"use client";

import type { TreeDataItem } from "@/components/ui/file-tree";

type TraefikEntry = { path: string; type: "file" | "directory"; size: number };

// The agent lists /etc/panara-cloud/traefik flat (paths relative to it);
// the tree nests them, directories first.
export const buildTraefikTree = (entries: TraefikEntry[]): TreeDataItem[] => {
	const root: TreeDataItem[] = [];
	const directories = new Map<string, TreeDataItem>();
	const childrenOf = (parent: string) => {
		if (!parent) return root;
		let directory = directories.get(parent);
		if (!directory) {
			const slash = parent.lastIndexOf("/");
			directory = {
				id: parent,
				name: parent.slice(slash + 1),
				type: "directory",
				children: [],
			};
			directories.set(parent, directory);
			childrenOf(slash === -1 ? "" : parent.slice(0, slash)).push(directory);
		}
		directory.children ??= [];
		return directory.children;
	};
	for (const entry of entries) {
		if (!entry.path) continue;
		const slash = entry.path.lastIndexOf("/");
		const parent = slash === -1 ? "" : entry.path.slice(0, slash);
		if (entry.type === "directory") {
			childrenOf(entry.path);
			continue;
		}
		childrenOf(parent).push({
			id: entry.path,
			name: entry.path.slice(slash + 1),
			type: "file",
		});
	}
	const sort = (items: TreeDataItem[]) => {
		items.sort((a, b) =>
			a.type === b.type
				? a.name.localeCompare(b.name)
				: a.type === "directory"
					? -1
					: 1,
		);
		for (const item of items) if (item.children) sort(item.children);
		return items;
	};
	return sort(root);
};
