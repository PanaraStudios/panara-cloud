"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useMemo } from "react";
import type { BadgeTone } from "@/components/ui-kit/primitives";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import type { ServiceInfo } from "./service-context";

export type DeploymentRow = FunctionReturnType<
	typeof api.jobs.deployments
>[number] & {
	rollback: { rollbackId: Id<"applicationRollbacks">; version: number } | null;
	live: boolean;
};

/** The service's deploy history (newest first, up to 50), with the
    application's rollback points. Undefined while loading. */
export function useServiceDeployments(
	service: ServiceInfo,
): DeploymentRow[] | undefined {
	const { active } = useOrganization();
	const permissions = usePermissions();
	const rows = useQuery(
		api.jobs.deployments,
		permissions.deployment.read
			? {
					organizationId: active.id,
					target: { kind: service.family, id: service.id },
				}
			: "skip",
	);
	const rollbacks = useQuery(
		api.applications.rollbacks.list,
		service.family === "application"
			? { applicationId: service.id as Id<"applications"> }
			: "skip",
	);
	return useMemo(() => {
		if (!permissions.deployment.read) return [];
		if (rows === undefined) return undefined;
		const byDeployment = new Map(
			(rollbacks ?? []).flatMap((rollback) =>
				rollback.deploymentId
					? [[rollback.deploymentId as string, rollback] as const]
					: [],
			),
		);
		const liveId = rows.find((row) => row.status === "succeeded")?._id;
		return rows.map((row) => {
			const rollback = byDeployment.get(row._id);
			return {
				...row,
				live: row._id === liveId,
				rollback: rollback
					? { rollbackId: rollback._id, version: rollback.version }
					: null,
			};
		});
	}, [permissions.deployment.read, rows, rollbacks]);
}

export function deploymentStatus(row: Pick<DeploymentRow, "status" | "live">): {
	label: string;
	tone: BadgeTone;
} {
	switch (row.status) {
		case "queued":
			return { label: "Queued", tone: "secondary" };
		case "running":
			return { label: "Deploying", tone: "info" };
		case "succeeded":
			return row.live
				? { label: "Live", tone: "success" }
				: { label: "Superseded", tone: "secondary" };
		case "failed":
			return { label: "Failed", tone: "destructive" };
		default:
			return { label: "Cancelled", tone: "secondary" };
	}
}

export function formatDuration(ms: number) {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const deploymentDuration = (
	row: Pick<DeploymentRow, "startedAt" | "finishedAt">,
	now = Date.now(),
) =>
	row.startedAt === undefined
		? null
		: formatDuration((row.finishedAt ?? now) - row.startedAt);

/** What started a deployment, from what the backend records. */
export function deploymentTrigger(
	row: Pick<DeploymentRow, "title" | "commit">,
): string {
	const title = row.title.toLowerCase();
	if (title.startsWith("rollback")) return "Rollback";
	if (title === "manual deployment") return "Manual";
	if (title === "redeploy") return "Redeploy";
	if (title === "rebuild deployment") return "Rebuild";
	if (row.commit) return "Push";
	return "Manual";
}

/** The commit message when there is one, else the deployment's title. */
export const deploymentTitle = (row: Pick<DeploymentRow, "title" | "commit">) =>
	row.commit?.message?.split("\n")[0] || row.title;

export const shortSha = (row: Pick<DeploymentRow, "commit"> | undefined) =>
	row?.commit?.sha.slice(0, 7) ?? null;
