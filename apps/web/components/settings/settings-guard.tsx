"use client";

import { api } from "@panara-cloud/backend/api";
import { useConvexAuth, useQuery } from "convex/react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { isActive, isVisible, settingsNav } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import type { Permissions } from "@/lib/permissions";

// Members only see the Settings pages their permissions allow; a hidden
// page's URL goes to the hub (or home when nothing on it is theirs).
export function SettingsGuard({ children }: { children: React.ReactNode }) {
	const pathname = usePathname();
	const router = useRouter();
	const { active } = useOrganization();
	const { isAuthenticated } = useConvexAuth();
	const resolved = useQuery(
		api.account.permissions,
		isAuthenticated ? { organizationId: active.id } : "skip",
	);
	const security = useQuery(
		api.account.security,
		isAuthenticated ? {} : "skip",
	);
	const permissions = resolved?.permissions as Permissions | undefined;
	const known = !!permissions && security !== undefined;
	const items = settingsNav.flatMap((group) => group.items);
	const current = items.find((item) => isActive(pathname, item.url));
	const allowed = (item: (typeof items)[number]) =>
		!known || isVisible(item, permissions, security?.instanceAdmin === true);
	const blocked = known && (current ? !allowed(current) : !items.some(allowed));
	const fallback = items.some(allowed) ? "/settings" : "/";

	useEffect(() => {
		if (blocked) router.replace(fallback);
	}, [blocked, fallback, router]);

	if (blocked) return null;
	return children;
}
