"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import copy from "copy-to-clipboard";
import { format, isPast } from "date-fns";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { StatusDot } from "@/components/settings/form-kit";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	type BadgeTone,
	ResourceTable,
	Th,
} from "@/components/ui-kit/primitives";
import { authClient } from "@/lib/auth/client";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";

const STATUS_TONE: Record<string, BadgeTone> = {
	pending: "warning",
	canceled: "secondary",
	rejected: "destructive",
};

/** The invitations table on Members: sent and not accepted. */
export const ShowInvitations = ({ search = "" }: { search?: string }) => {
	const { active } = useOrganization();
	const data = useQuery(api.account.invitations, {
		organizationId: active.id,
	})?.filter(
		(invitation) =>
			invitation.status !== "accepted" &&
			(!search || invitation.email.toLowerCase().includes(search)),
	);

	const removeInvitation = useMutation(api.account.removeInvitation);

	if (data === undefined)
		return <p className="py-3 text-muted-foreground text-sm">Loading…</p>;
	if (data.length === 0)
		return (
			<p className="py-3 text-muted-foreground text-sm">
				No invitations match.
			</p>
		);

	return (
		<ResourceTable
			headers={
				<>
					<Th>Email</Th>
					<Th>Role</Th>
					<Th>Status</Th>
					<Th>Expires</Th>
					<Th className="w-12" />
				</>
			}
		>
			{data.map((invitation) => {
				const isExpired = isPast(new Date(invitation.expiresAt));
				return (
					<TableRow key={invitation.id}>
						<TableCell className="font-medium">{invitation.email}</TableCell>
						<TableCell className="capitalize">{invitation.role}</TableCell>
						<TableCell>
							<StatusDot tone={STATUS_TONE[invitation.status] ?? "secondary"}>
								<span className="capitalize">{invitation.status}</span>
							</StatusDot>
						</TableCell>
						<TableCell className="whitespace-nowrap text-muted-foreground">
							{isExpired
								? "Expired"
								: format(new Date(invitation.expiresAt), "PP, p")}
						</TableCell>
						<TableCell className="text-right">
							<DropdownMenu>
								<DropdownMenuTrigger
									render={<Button variant="ghost" size="icon-sm" />}
								>
									<span className="sr-only">Open menu</span>
									<MoreHorizontal />
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="min-w-48">
									{!isExpired && (
										<>
											{invitation.status === "pending" && (
												<DropdownMenuItem
													onClick={() => {
														copy(
															`${window.location.origin}/invitation?id=${encodeURIComponent(invitation.id)}`,
														);
														toast.success("Invitation Copied to clipboard");
													}}
												>
													Copy link
												</DropdownMenuItem>
											)}

											{invitation.status === "pending" && (
												<DropdownMenuItem
													onClick={async () => {
														const result =
															await authClient.organization.cancelInvitation({
																invitationId: invitation.id,
															});

														if (result.error) {
															toast.error(result.error.message);
														} else {
															toast.success("Invitation deleted");
														}
													}}
												>
													Cancel invitation
												</DropdownMenuItem>
											)}
										</>
									)}
									<DropdownMenuItem
										onClick={async () => {
											await removeInvitation({
												organizationId: active.id,
												invitationId: invitation.id,
											})
												.then(() => {
													toast.success("Invitation removed");
												})
												.catch((error) => {
													toast.error(errorMessage(error));
												});
										}}
									>
										Remove invitation
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</TableCell>
					</TableRow>
				);
			})}
		</ResourceTable>
	);
};
