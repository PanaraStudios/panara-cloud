"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { useEffect, useState } from "react";
import { errorMessage } from "@/lib/auth/errors";
import { hostId, useWaitForOp } from "../../servers/host-jobs";

type JoinInfo = {
	address: string;
	version: string;
	worker: string;
	manager: string;
};

// The join command for a new worker or manager: the agent reads the Swarm
// join tokens of the host (an admin-only op result).
export function useClusterJoinInfo(
	serverId: string | undefined,
	role: "worker" | "manager",
) {
	const runDocker = useMutation(api.infra.docker.run);
	const waitForOp = useWaitForOp();
	const [state, setState] = useState<
		| { status: "pending" }
		| { status: "done"; info: JoinInfo }
		| { status: "error"; message: string }
	>({ status: "pending" });

	useEffect(() => {
		let cancelled = false;
		setState({ status: "pending" });
		runDocker({
			serverId: hostId(serverId),
			action: { type: "clusterJoinInfo" },
		})
			.then((jobId) => waitForOp<JoinInfo>(jobId))
			.then((info) => {
				if (!cancelled) setState({ status: "done", info });
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					setState({ status: "error", message: errorMessage(error) });
				}
			});
		return () => {
			cancelled = true;
		};
	}, [runDocker, waitForOp, serverId]);

	const info = state.status === "done" ? state.info : null;
	return {
		data: info ? { version: info.version, command: info[role] } : undefined,
		isPending: state.status === "pending",
		isError: state.status === "error",
		error: state.status === "error" ? { message: state.message } : null,
	};
}
