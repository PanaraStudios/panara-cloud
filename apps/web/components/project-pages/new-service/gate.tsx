"use client";

import { api } from "@panara-cloud/backend/api";
import { useConvexAuth, useQuery } from "convex/react";
import { AccessDeniedState } from "@/components/ui-kit/primitives";
import { useOrganization } from "@/lib/organization";
import type { Permissions } from "@/lib/permissions";

/** The create flows are for whoever may create services. The grant is per
    member, so nothing shows until the backend has answered: the role's
    defaults would refuse a member who was given it. */
export function NewServiceGate({ children }: { children: React.ReactNode }) {
	const { active } = useOrganization();
	const { isAuthenticated } = useConvexAuth();
	const resolved = useQuery(
		api.account.permissions,
		isAuthenticated ? { organizationId: active.id } : "skip",
	);
	if (!resolved) return null;
	if (!(resolved.permissions as Permissions).service.create) {
		return <AccessDeniedState what="creating services" />;
	}
	return children;
}
