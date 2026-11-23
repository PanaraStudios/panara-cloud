"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";

export type VolumeBackupServiceType =
	| "application"
	| "compose"
	| "postgres"
	| "mariadb"
	| "mongo"
	| "mysql"
	| "redis"
	| "libsql";

// Volume backups belong to an application, a compose service or a database
// (every database engine shares the `databases` table).
export const volumeOwner = (type: VolumeBackupServiceType, id: string) => ({
	kind:
		type === "application" || type === "compose" ? type : ("database" as const),
	id,
});

// The named volumes a compose service's running container uses, read by an
// agent job.
export function useComposeMounts(
	composeId: string | undefined,
	serviceName: string,
	enabled: boolean,
) {
	const loadMounts = useMutation(api.compose.hostOps.loadMounts);
	const [opId, setOpId] = useState<Id<"composeOps"> | null>(null);
	const op = useQuery(api.compose.deploy.getOp, opId ? { opId } : "skip");

	useEffect(() => {
		setOpId(null);
		if (!enabled || !composeId || !serviceName) return;
		let cancelled = false;
		loadMounts({ composeId: composeId as Id<"compose">, serviceName })
			.then((result) => {
				if (!cancelled) setOpId(result.opId);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [enabled, composeId, serviceName, loadMounts]);

	if (!op?.result) return undefined;
	try {
		return JSON.parse(op.result) as { Name?: string }[];
	} catch {
		return undefined;
	}
}

export type BackupFile = {
	Path: string;
	Name: string;
	Size: number;
	IsDir: boolean;
	ModTime?: string;
	Hashes?: { MD5?: string };
};

// The files in a backup destination: browsing it runs as an agent job on the
// given server; `search` is a path whose last segment filters that folder.
export function useBackupFiles(
	destinationId: string,
	search: string,
	serverId: string | undefined,
	enabled: boolean,
) {
	const listFiles = useMutation(api.databases.destinations.listFiles);
	const [opId, setOpId] = useState<Id<"databaseOps"> | null>(null);
	const op = useQuery(
		api.databases.destinations.opResult,
		opId ? { opId } : "skip",
	);

	useEffect(() => {
		setOpId(null);
		if (!enabled || !destinationId) return;
		let cancelled = false;
		listFiles({
			destinationId: destinationId as Id<"destinations">,
			search,
			serverId: serverId ? (serverId as Id<"servers">) : undefined,
		})
			.then((result) => {
				if (!cancelled) setOpId(result.opId);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [enabled, destinationId, search, serverId, listFiles]);

	const done = !!op && (op.done || op.error !== null);
	return {
		data: done && Array.isArray(op.result) ? (op.result as BackupFile[]) : [],
		isPending: enabled && !!destinationId && !done,
		error: op?.error ?? null,
	};
}
