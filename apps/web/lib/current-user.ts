"use client";

import { authClient } from "@/lib/auth/client";
import { useOrganization } from "@/lib/organization";

// Who is signed in and their role in the active organization.
export function useCurrentUser() {
	const { data } = authClient.useSession();
	const { active } = useOrganization();
	const user = data?.user;
	return user
		? {
				id: user.id,
				email: user.email,
				name: user.name,
				image: user.image ?? null,
				role: active.role,
				organizationId: active.id,
			}
		: undefined;
}
