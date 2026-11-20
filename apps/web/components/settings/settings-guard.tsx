"use client";

import { api } from "@panara-cloud/backend/api";
import { useConvexAuth, useQuery } from "convex/react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { settingsNav } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import type { Permissions } from "@/lib/permissions";

// Members only see the Settings sections their permissions allow; a hidden
// section's URL goes to the first allowed one (or home when there is none).
export function SettingsGuard({ children }: { children: React.ReactNode }) {
	const pathname = usePathname();
	const router = useRouter();
	const { active } = useOrganization();
	const { isAuthenticated } = useConvexAuth();
	const resolved = useQuery(
		api.account.permissions,
		isAuthenticated ? { organizationId: active.id } : "skip",
	);
	const permissions = resolved?.permissions as Permissions | undefined;
	const items = settingsNav.flatMap((group) => group.items);
	const current = items.find(
		(item) => pathname === item.url || pathname.startsWith(`${item.url}/`),
	);
	const allowed = (item: (typeof items)[number]) =>
		!permissions || !item.enabled || item.enabled(permissions);
	const blocked = !!permissions && !!current && !allowed(current);
	const fallback = items.find(allowed)?.url ?? "/";

	useEffect(() => {
		if (blocked) router.replace(fallback);
	}, [blocked, fallback, router]);

	if (blocked) return null;
	return children;
}
