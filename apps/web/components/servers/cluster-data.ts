"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { useEffect, useState } from "react";
import {
	hostId,
	useWaitForOp,
} from "@/components/dashboard/settings/servers/host-jobs";
import { errorMessage } from "@/lib/auth/errors";

type JoinInfo = {
	address: string;
	/** The Docker version of this server: nodes should run the same. */
	version: string;
	worker: string;
	manager: string;
};

/** The cluster's join commands, read from the server by one
    `clusterJoinInfo` job (admins only). They carry the join tokens, so
    nothing asks for them until `enabled`. */
export function useJoinInfo(serverId: string | undefined, enabled: boolean) {
	const runDocker = useMutation(api.infra.docker.run);
	const waitForOp = useWaitForOp();
	const [state, setState] = useState<{ info?: JoinInfo; error?: string }>();
	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		setState(undefined);
		runDocker({
			serverId: hostId(serverId),
			action: { type: "clusterJoinInfo" },
		})
			.then((jobId) => waitForOp<JoinInfo>(jobId))
			.then(
				(info) => !cancelled && setState({ info }),
				(error: unknown) =>
					!cancelled && setState({ error: errorMessage(error) }),
			);
		return () => {
			cancelled = true;
		};
	}, [runDocker, waitForOp, serverId, enabled]);
	return {
		info: state?.info,
		error: state ? (state.error ?? (state.info ? null : "No answer")) : null,
		isLoading: enabled && state === undefined,
	};
}
