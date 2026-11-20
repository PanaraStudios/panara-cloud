"use client";

import { api } from "@panara-cloud/backend/api";
import { useQuery } from "convex/react";
import { useHostSnapshot } from "@/components/dashboard/settings/servers/host-jobs";
import type { PanelStatus } from "@/components/dashboard/settings/web-server/panel-actions";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";

export const SETUP_URL = "/setup";

export type SetupStepId =
	| "domain"
	| "server-ip"
	| "direct-port"
	| "email"
	| "two-factor"
	| "backups"
	| "git";

export type SetupStep = {
	id: SetupStepId;
	title: string;
	optional: boolean;
	/** `undefined` while the fact behind it is loading or unknown. */
	done: boolean | undefined;
	/** Where the step is done: its place on the setup screen, or its page. */
	href: string;
};

/** Whether the one-time panel setup is due for the signed-in account. */
export function usePanelSetupStatus(enabled = true) {
	return useQuery(api.platform.onboarding.status, enabled ? {} : "skip");
}

export const PANEL_BACKUPS_ID = "panel-backups";
const PANEL_BACKUPS_URL = `/settings/general#${PANEL_BACKUPS_ID}`;

/** The facts behind each setup step, read from the queries their own
    settings pages use. Only the instance administrator may read them all. */
export function usePanelSetup({
	refreshPanel = false,
}: {
	/** Ask the agent for the panel's current state (the setup screen does;
	    the checklist on Projects reads what is stored). */
	refreshPanel?: boolean;
} = {}) {
	const { active } = useOrganization();
	const permissions = usePermissions();
	const web = useQuery(api.infra.webServer.get);
	const email = useQuery(api.email.settings);
	const security = useQuery(api.account.security);
	const backups = useQuery(api.databases.panelBackups.list);
	const canReadStorage =
		permissions.destination.read || permissions.backup.read;
	const destinations = useQuery(
		api.databases.destinations.list,
		canReadStorage ? { organizationId: active.id } : "skip",
	);
	const gitProviders = useQuery(api.sources.usable.list, {
		organizationId: active.id,
	});
	const panel = useHostSnapshot<PanelStatus>(undefined, "panel", {
		refreshOnMount: refreshPanel,
	});

	const hasStorage = canReadStorage ? (destinations?.length ?? 0) > 0 : true;
	const facts = {
		web,
		email,
		twoFactorEnabled: security?.twoFactorEnabled,
		panelBackups: backups?.length,
		hasStorage,
		gitProviders,
		directPortOpen: panel.data?.panelPortPublished ?? undefined,
		panelPort: panel.data?.panelPort ?? 3000,
	};

	const steps: SetupStep[] = [
		{
			id: "domain",
			title: "Panel domain and HTTPS",
			optional: false,
			done: web && Boolean(web.host),
			href: `${SETUP_URL}#domain`,
		},
		{
			id: "server-ip",
			title: "Server IP",
			optional: false,
			done: web && Boolean(web.serverIp),
			href: `${SETUP_URL}#server-ip`,
		},
		{
			id: "direct-port",
			title: `Direct access on port ${facts.panelPort}`,
			optional: true,
			done:
				facts.directPortOpen === undefined ? undefined : !facts.directPortOpen,
			href: `${SETUP_URL}#direct-port`,
		},
		{
			id: "email",
			title: "Email",
			optional: true,
			done: email && (email.provider !== null || email.mode === "env"),
			href: "/settings/email",
		},
		{
			id: "two-factor",
			title: "Protect your account",
			optional: true,
			done: facts.twoFactorEnabled,
			href: "/account/security",
		},
		{
			id: "backups",
			title: "Panel backups",
			optional: true,
			done: backups && backups.length > 0,
			href: hasStorage ? PANEL_BACKUPS_URL : "/settings/s3",
		},
		{
			id: "git",
			title: "Git provider",
			optional: true,
			done: gitProviders && gitProviders.length > 0,
			href: "/settings/git",
		},
	];

	return {
		facts,
		steps,
		doneCount: steps.filter((step) => step.done).length,
		requiredRemaining: steps.some((step) => !step.optional && !step.done),
		isLoading: steps.some(
			(step) => step.done === undefined && step.id !== "direct-port",
		),
	};
}

export type PanelSetup = ReturnType<typeof usePanelSetup>;
