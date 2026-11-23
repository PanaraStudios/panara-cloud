"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { useEffect, useState } from "react";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { hostId, useWaitForOp } from "../servers/host-jobs";

// A container of one service as the agent's containerList returns it.
export type HostContainer = {
	containerId: string;
	name: string;
	state: string;
	status: string;
};

type AppType = "standalone" | "swarm" | "stack" | "docker-compose" | undefined;

// The container pickers of the logs and terminal dialogs: containers matched
// by app label or app name, asked from the agent when the dialog opens (running containers only). Allowed by the service
// and docker permissions, also on the panel host.
export function useAppContainers({
	serverId,
	appName,
	appType,
	enabled,
}: {
	serverId: string | null | undefined;
	appName: string;
	appType: AppType;
	enabled: boolean;
}) {
	const { active } = useOrganization();
	const listAppContainers = useMutation(api.infra.docker.listAppContainers);
	const waitForOp = useWaitForOp();
	const [state, setState] = useState<{
		key: string | null;
		data: HostContainer[] | undefined;
		error: string | null;
	}>({ key: null, data: undefined, error: null });
	const key =
		enabled && appName
			? JSON.stringify([active.id, serverId ?? null, appName, appType ?? null])
			: null;

	useEffect(() => {
		if (!key) return;
		let cancelled = false;
		setState({ key, data: undefined, error: null });
		listAppContainers({
			organizationId: active.id,
			serverId: hostId(serverId),
			appName,
			appType,
		})
			.then((jobId) => waitForOp<HostContainer[]>(jobId))
			.then(
				(containers) =>
					!cancelled &&
					setState({
						key,
						data: containers.filter(
							(container) => container.state === "running",
						),
						error: null,
					}),
				(error: unknown) =>
					!cancelled &&
					setState({
						key,
						data: [],
						error: error instanceof Error ? errorMessage(error) : String(error),
					}),
			);
		return () => {
			cancelled = true;
		};
	}, [key]);

	const current = state.key === key ? state : null;
	return {
		data: current?.data,
		error: current?.error ?? null,
		isLoading: !!key && current?.data === undefined,
	};
}
