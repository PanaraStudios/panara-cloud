"use client";

import { useMemo } from "react";
import { useLiveRpc } from "@/lib/host-data";
import type { LiveRequest } from "@/lib/live";
import { useOrganization } from "@/lib/organization";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type FileEntry = {
	name: string;
	type: "file" | "directory" | "symlink" | "other";
	size: number | null;
	mode: string | null;
	modifiedAt: string | null;
};

export type FileContent = {
	path: string;
	size: number;
	encoding: "utf8" | "base64";
	content: string;
	// Set when only the first 512 KB came back (`preview` reads).
	truncated?: boolean;
};

export type FilesTarget =
	| { type: "container"; containerId: string }
	| { type: "volume"; volumeName: string };

// A `files` live session on the host (the container/volume file
// endpoints): list, read, write and delete. Opens only while `enabled`.
export function useFilesSession(
	target: FilesTarget | null,
	serverId: string | undefined,
	enabled: boolean,
) {
	const { active } = useOrganization();
	const request = useMemo<LiveRequest | null>(
		() =>
			enabled && target
				? {
						kind: "files",
						scope: {
							type: "host",
							organizationId: active.id,
							serverId: (serverId || undefined) as never,
						},
						target,
					}
				: null,
		[enabled, target, active.id, serverId],
	);
	const { call, status, error } = useLiveRpc(request);
	return {
		status,
		error,
		list: (path: string) =>
			call<{ path: string; entries: FileEntry[] }>("list", { path }),
		read: (path: string, options: { preview?: boolean } = {}) =>
			call<FileContent>("read", { path, ...options }),
		write: (
			path: string,
			content: string,
			encoding: "utf8" | "base64" = "utf8",
		) =>
			call<{ path: string; size: number }>("write", {
				path,
				content,
				encoding,
			}),
		remove: (path: string) => call<{ path: string }>("delete", { path }),
	};
}

export const fileToBase64 = async (file: File) => {
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
};

export const joinPath = (dir: string, name: string) =>
	`${dir.replace(/\/+$/, "")}/${name}`;
