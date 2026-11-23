"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";

export type PatchServiceType = "application" | "compose";

export type RepoResult = {
	done: boolean;
	error: string | null;
	result: unknown;
};

const FINISHED = new Set(["succeeded", "failed", "cancelled"]);

// Browsing a service's repository runs as an agent job (clone, list, read);
// `ref` is what the request returned: a job id for applications, an op id
// for compose.
export function usePatchRepoRequests(id: string, type: PatchServiceType) {
	const appTree = useMutation(api.applications.patchRepo.requestTree);
	const appFile = useMutation(api.applications.patchRepo.requestFile);
	const composeTree = useMutation(api.compose.hostOps.requestPatchTree);
	const composeFile = useMutation(api.compose.hostOps.requestPatchFile);
	return {
		requestTree: async (): Promise<string> =>
			type === "application"
				? await appTree({ applicationId: id as Id<"applications"> })
				: (await composeTree({ composeId: id as Id<"compose"> })).opId,
		requestFile: async (path: string): Promise<string> =>
			type === "application"
				? await appFile({ applicationId: id as Id<"applications">, path })
				: (await composeFile({ composeId: id as Id<"compose">, path })).opId,
	};
}

export function usePatchRepoResult(
	type: PatchServiceType,
	ref: string | null,
): RepoResult | undefined {
	const app = useQuery(
		api.applications.patchRepo.result,
		ref && type === "application" ? { jobId: ref as Id<"jobs"> } : "skip",
	);
	const op = useQuery(
		api.compose.deploy.getOp,
		ref && type === "compose" ? { opId: ref as Id<"composeOps"> } : "skip",
	);
	if (!ref) return undefined;
	if (type === "application") {
		if (!app) return undefined;
		return {
			done: FINISHED.has(app.status),
			error: app.error,
			result: app.result,
		};
	}
	if (!op) return undefined;
	let result: unknown = null;
	try {
		result = op.result ? JSON.parse(op.result) : null;
	} catch {
		result = null;
	}
	return {
		done: op.completedAt !== undefined,
		error: op.error ?? null,
		result,
	};
}
