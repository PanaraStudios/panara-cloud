"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useConvex, useMutation } from "convex/react";
import { useEffect, useState } from "react";
import { useOpResult, waitForJob } from "@/lib/host-data";
import type { ServiceKind } from "./live-stats";

export type ServiceContainer = {
	containerId: string;
	name: string;
	state: string;
	status: string;
};

// The containers of one service, matched by its app name.
export function useServiceContainers(
	serviceKind: ServiceKind,
	serviceId: string | undefined,
) {
	const list = useMutation(api.infra.docker.listServiceContainers);
	const [jobId, setJobId] = useState<Id<"jobs"> | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (!serviceId) return;
		let cancelled = false;
		setJobId(null);
		setError(null);
		list({ serviceKind, serviceId }).then(
			(id) => !cancelled && setJobId(id),
			(err: unknown) =>
				!cancelled &&
				setError(err instanceof Error ? err.message : String(err)),
		);
		return () => {
			cancelled = true;
		};
	}, [list, serviceKind, serviceId]);
	const op = useOpResult<ServiceContainer[]>(jobId);
	return {
		data: op.data,
		error: error ?? op.error,
		isPending: !!serviceId && !error && !op.error && op.data === undefined,
	};
}

// Restarts a container; resolves once the agent restarted it.
export function useRestartContainer() {
	const run = useMutation(api.infra.docker.run);
	const convex = useConvex();
	const [isPending, setPending] = useState(false);
	const restart = async ({
		containerId,
		serverId,
	}: {
		containerId: string;
		serverId?: string;
	}) => {
		setPending(true);
		try {
			const jobId = await run({
				serverId: (serverId || undefined) as Id<"servers"> | undefined,
				action: { type: "containerRestart", containerId },
			});
			await waitForJob(convex, jobId);
		} finally {
			setPending(false);
		}
	};
	return { mutateAsync: restart, isPending };
}
