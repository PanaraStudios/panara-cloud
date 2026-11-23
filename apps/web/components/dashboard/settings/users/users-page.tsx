"use client";

import { api } from "@panara-cloud/backend/api";
import { useQuery } from "convex/react";
import { ShieldIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Section } from "@/components/ui-kit/primitives";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { useRouter } from "@/lib/router";
import { ShowUsers } from "./show-users";

// Users and invitations page, with the fixed roles (there are no custom
// roles).
const ROLES = [
	["Owner", "Everything, including deleting the organization."],
	[
		"Admin",
		"All projects, servers and settings. Can invite and remove members.",
	],
	[
		"Member",
		"Only the projects and sections they are granted, with per-project rights such as deploy, logs, terminal and environment.",
	],
] as const;

export const UsersPage = () => {
	const router = useRouter();
	const permissions = usePermissions();
	const canReadMembers = permissions.member.read;
	const canCreateMembers = permissions.member.create;
	const { active } = useOrganization();
	const invitations = useQuery(
		api.account.invitations,
		canCreateMembers ? { organizationId: active.id } : "skip",
	);
	const [view, setView] = useState<"all" | "pending">("all");

	useEffect(() => {
		if (!canReadMembers) router.replace("/");
	}, [canReadMembers, router]);

	if (!canReadMembers) return null;
	const invitationCount =
		invitations?.filter((invitation) => invitation.status !== "accepted")
			.length ?? 0;
	return (
		<div className="flex w-full flex-col gap-8">
			<ShowUsers
				view={invitationCount > 0 ? view : "all"}
				onViewChange={canCreateMembers ? setView : undefined}
				invitationCount={invitationCount}
			/>
			<Section title="Roles" icon={ShieldIcon}>
				<dl className="divide-y divide-border text-sm">
					{ROLES.map(([role, description]) => (
						<div key={role} className="grid grid-cols-[8rem_1fr] gap-4 py-3">
							<dt className="font-medium">{role}</dt>
							<dd className="text-muted-foreground">{description}</dd>
						</div>
					))}
				</dl>
			</Section>
		</div>
	);
};
