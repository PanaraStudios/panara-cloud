"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useCallback, useEffect } from "react";
import { useOrganization } from "@/lib/organization";
import { useHostSnapshot, useWaitForOp } from "../servers/host-jobs";

type PanelAction = FunctionArgs<typeof api.infra.panel.runAction>["action"];

// The agent's "panel" snapshot (apps/agent/src/infra/panel.ts readPanelStatus).
export type PanelStatus = {
	version: string;
	releaseTag: string;
	panelPort: number;
	webService: string | null;
	webServiceKind: "service" | "container" | "missing";
	panelPortPublished: boolean | null;
	recoveryCommand: string;
	services: {
		name: string;
		repository: string;
		kind: "service" | "container" | "missing";
		image: string | null;
		running: boolean;
	}[];
};

// What the update check reports.
export type UpdateData = {
	currentVersion: string;
	releaseTag: string;
	latestVersion: string | null;
	updateAvailable: boolean;
};

// Only instance administrators manage the panel; everyone else gets null.
export function usePanelStatus(options: { refreshOnMount?: boolean } = {}) {
	const isInstanceAdmin = useQuery(api.infra.webServer.isInstanceAdmin, {});
	const snapshot = useHostSnapshot<PanelStatus>(undefined, "panel", {
		enabled: isInstanceAdmin === true,
		refreshOnMount: options.refreshOnMount,
	});
	return { ...snapshot, isInstanceAdmin: isInstanceAdmin === true };
}

// Runs a panel action on the agent and resolves with its result.
export function useRunPanelAction() {
	const runAction = useMutation(api.infra.panel.runAction);
	const waitForOp = useWaitForOp();
	return useCallback(
		async <T = unknown>(action: PanelAction) => {
			const jobId = await runAction({
				action,
				currentHost: window.location.host,
			});
			return await waitForOp<T>(jobId);
		},
		[runAction, waitForOp],
	);
}

// Asks the agent to look up the panel host's
// public address (any member may) and returns the last one it found.
export function usePanelPublicIp(enabled = true) {
	const { active } = useOrganization();
	const webServer = useQuery(api.infra.webServer.get, enabled ? {} : "skip");
	const detect = useMutation(api.infra.panel.detectPublicIp);
	useEffect(() => {
		if (enabled) detect({ organizationId: active.id }).catch(() => {});
	}, [enabled, detect, active.id]);
	return webServer?.publicIp;
}
