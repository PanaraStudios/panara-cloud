"use client";

import { useParams } from "next/navigation";
import { isServiceKind, type ServiceRef } from "@/lib/navigation";

/** The service of the current `…/services/[kind]/[id]/…` route. */
export function useServiceRef(): ServiceRef | null {
	const params = useParams<{
		projectId: string;
		environmentId: string;
		kind: string;
		id: string;
	}>();
	if (!params.kind || !isServiceKind(params.kind) || !params.id) return null;
	return {
		projectId: params.projectId,
		environmentId: params.environmentId,
		kind: params.kind,
		id: params.id,
	};
}
