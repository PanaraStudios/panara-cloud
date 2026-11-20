"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useQuery } from "convex/react";

export type BackupFile = {
	Path: string;
	Name: string;
	Size: number;
	IsDir: boolean;
	ModTime?: string;
	Hashes?: { MD5?: string };
};

export type OpId = Id<"databaseOps">;

// Bucket listings run on the agent: the caller starts one (a mutation that
// returns `{ opId }`) and this follows its result.
export const useBackupFiles = (opId: OpId | null) => {
	const op = useQuery(
		api.databases.destinations.opResult,
		opId ? { opId } : "skip",
	);
	const failed = !!op?.error || op?.status === "cancelled";
	const files =
		op?.done && !failed && Array.isArray(op.result)
			? (op.result as BackupFile[])
			: undefined;
	return {
		files,
		isPending: opId === null || (!op?.done && !failed && op !== null),
		isError: failed,
		error: { message: op?.error ?? "Error listing the backup files" },
	};
};
