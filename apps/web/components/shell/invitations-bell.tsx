"use client";

import { BellIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { authClient, authResult } from "@/lib/auth/client";

export type PendingInvitation = {
	id: string;
	organizationId: string;
	organizationName?: string;
	role: string;
	status: string;
	expiresAt: Date | string;
};

/** `pollMs` re-checks on an interval (the no-organization screen waits for one). */
export function usePendingInvitations(pollMs?: number) {
	const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (!pollMs) return;
		const timer = setInterval(() => setTick((value) => value + 1), pollMs);
		return () => clearInterval(timer);
	}, [pollMs]);
	useEffect(() => {
		let cancelled = false;
		void tick;
		authResult(authClient.organization.listUserInvitations())
			.then((rows) => {
				if (cancelled) return;
				const now = Date.now();
				setInvitations(
					(rows as PendingInvitation[]).filter(
						(row) =>
							row.status === "pending" &&
							new Date(row.expiresAt).getTime() > now,
					),
				);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);
	return invitations;
}

export function InvitationsBell() {
	const invitations = usePendingInvitations();
	const count = invitations.length;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<SidebarMenuButton
						size="icon"
						tooltip="Invitations"
						className="relative"
						aria-label={
							count > 0
								? `${count} pending invitation${count === 1 ? "" : "s"}`
								: "No pending invitations"
						}
					/>
				}
			>
				<BellIcon />
				{count > 0 && (
					<span className="absolute top-0.5 right-0.5 flex size-3.5 items-center justify-center rounded-full bg-foreground font-mono text-[9px] text-background">
						{count}
					</span>
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent className="w-72" align="start" side="top">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Pending invitations</DropdownMenuLabel>
					{count === 0 ? (
						<p className="px-1.5 py-2 text-sm text-muted-foreground">
							No pending invitations.
						</p>
					) : (
						invitations.map((invitation) => (
							<DropdownMenuItem
								key={invitation.id}
								render={<Link href={`/invitation?id=${invitation.id}`} />}
							>
								<span className="flex flex-col">
									<span className="font-medium">
										{invitation.organizationName ?? "An organization"}
									</span>
									<span className="text-xs text-muted-foreground">
										Invited as {invitation.role}
									</span>
								</span>
							</DropdownMenuItem>
						))
					)}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
