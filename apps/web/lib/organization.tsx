"use client";

import { api } from "@panara-cloud/backend/api";
import { useConvexAuth, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { createContext, useContext, useEffect, useRef } from "react";
import { authClient } from "@/lib/auth/client";

export type Organization = NonNullable<
	FunctionReturnType<typeof api.account.organizations>
>[number];

type OrganizationState = {
	organizations: Organization[];
	active: Organization;
	canManage: boolean;
	switchTo: (organizationId: string) => Promise<void>;
};

const OrganizationContext = createContext<OrganizationState | null>(null);

// Session changes (password change, 2FA, passkeys) refresh the Convex auth
// token, which briefly reports "not authenticated". Keep the last list during
// that window so the dashboard isn't unmounted mid-action.
export function useOrganizations() {
	const { isAuthenticated } = useConvexAuth();
	const organizations = useQuery(
		api.account.organizations,
		isAuthenticated ? {} : "skip",
	);
	const last = useRef<Organization[] | undefined>(undefined);
	if (organizations) last.current = organizations;
	return organizations ?? last.current;
}

// The active organization lives on the Better Auth session so it follows the
// session across reloads; if it is unset or stale we fall back to the user's
// default organization (else the first membership) and persist that choice.
export function OrganizationProvider({
	organizations,
	children,
}: {
	organizations: Organization[];
	children: React.ReactNode;
}) {
	const { data: session, isPending } = authClient.useSession();
	const activeId = session?.session.activeOrganizationId;
	const active =
		organizations.find((org) => org.id === activeId) ??
		organizations.find((org) => org.isDefault) ??
		organizations[0];

	useEffect(() => {
		if (!isPending && active && active.id !== activeId) {
			void authClient.organization.setActive({ organizationId: active.id });
		}
	}, [isPending, active, activeId]);

	if (!active) return null;
	return (
		<OrganizationContext.Provider
			value={{
				organizations,
				active,
				canManage: active.role === "owner" || active.role === "admin",
				switchTo: async (organizationId) => {
					await authClient.organization.setActive({ organizationId });
				},
			}}
		>
			{children}
		</OrganizationContext.Provider>
	);
}

export function useOrganization() {
	const state = useContext(OrganizationContext);
	if (!state) {
		throw new Error("useOrganization must be used inside OrganizationProvider");
	}
	return state;
}

export function slugify(name: string) {
	const base = name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `${base || "org"}-${Math.random().toString(36).slice(2, 8)}`;
}

// Only the instance administrator creates organizations; everyone else joins
// through an invitation (enforced by the backend).
export function useIsInstanceAdmin() {
	const { isAuthenticated } = useConvexAuth();
	const security = useQuery(
		api.account.security,
		isAuthenticated ? {} : "skip",
	);
	return security?.instanceAdmin === true;
}
