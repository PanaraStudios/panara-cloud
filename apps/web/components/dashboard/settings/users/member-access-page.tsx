"use client";

import { api } from "@panara-cloud/backend/api";
import { useQuery } from "convex/react";
import { UserIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import {
	NotFoundState,
	StatCell,
	StatStrip,
} from "@/components/ui-kit/primitives";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { MemberAccess } from "./add-permissions";
import { ChangeRole } from "./change-role";
import { initials } from "./show-users";

/** Settings › Members › member: project access and what they can do. */
export function MemberAccessPage({ userId }: { userId: string }) {
	const router = useRouter();
	const { active } = useOrganization();
	const permissions = usePermissions();
	const members = useQuery(api.account.members, { organizationId: active.id });
	const member = members?.find((item) => item.userId === userId);

	useEffect(() => {
		if (!permissions.member.update) router.replace("/settings/members");
	}, [permissions.member.update, router]);

	if (members === undefined) {
		return (
			<div className="flex max-w-3xl flex-col gap-8" aria-busy="true">
				<Skeleton className="h-12 w-64" />
				<Skeleton className="h-16 w-full" />
				<Skeleton className="h-64 w-full" />
			</div>
		);
	}
	if (!member) {
		return (
			<NotFoundState
				icon={UserIcon}
				noun="member"
				backHref="/settings/members"
				description="They may have been removed from the organization."
			/>
		);
	}
	const name = member.name || member.email;
	const isPrivileged = member.role === "owner" || member.role === "admin";
	return (
		<div className="flex w-full max-w-3xl flex-col gap-8">
			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0 space-y-1">
					<p className="text-muted-foreground text-sm">
						<Link href="/settings/members" className="hover:text-foreground">
							Members
						</Link>{" "}
						/
					</p>
					<div className="flex min-w-0 items-center gap-2.5">
						<Avatar className="size-7">
							{member.image ? <AvatarImage src={member.image} alt="" /> : null}
							<AvatarFallback className="text-[11px]">
								{initials(name)}
							</AvatarFallback>
						</Avatar>
						<h1 className="truncate text-h3">{name}</h1>
					</div>
				</div>
				{permissions.member.update && member.role !== "owner" ? (
					<ChangeRole
						memberId={member.id}
						currentRole={member.role}
						userEmail={member.email}
						asButton
					/>
				) : null}
			</div>
			<StatStrip className="lg:grid-flow-row lg:grid-cols-[2fr_1fr_1fr_1fr]">
				<StatCell label="Email">
					<span className="truncate">{member.email}</span>
				</StatCell>
				<StatCell label="Role">
					<span className="capitalize">{member.role}</span>
				</StatCell>
				<StatCell label="Joined">
					{new Date(member.createdAt).toLocaleDateString(undefined, {
						month: "short",
						day: "numeric",
						year: "numeric",
					})}
				</StatCell>
				<StatCell label="Two-factor">
					{member.twoFactorEnabled ? "On" : "Off"}
				</StatCell>
			</StatStrip>
			{isPrivileged ? (
				<p className="text-muted-foreground text-sm">
					{member.role === "owner" ? "Owners" : "Admins"} have access to every
					project, server and setting, so there is nothing to grant here.
				</p>
			) : (
				<MemberAccess userId={userId} name={name} />
			)}
		</div>
	);
}
