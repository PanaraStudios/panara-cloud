"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import { format } from "date-fns";
import { MoreHorizontal, SearchIcon, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { StatusDot } from "@/components/settings/form-kit";
import { DialogAction } from "@/components/shared/dialog-action";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { TableCell, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	EmptyState,
	PageHeader,
	ResourceTable,
	Th,
} from "@/components/ui-kit/primitives";
import { authClient, authResult } from "@/lib/auth/client";
import { errorMessage } from "@/lib/auth/errors";
import { useCurrentUser } from "@/lib/current-user";
import { useIsInstanceAdmin, useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { AddInvitation } from "./add-invitation";
import { ChangeRole } from "./change-role";
import { ResetPasswordLink } from "./reset-password-link";
import { ShowInvitations } from "./show-invitations";

export const initials = (value: string) =>
	value
		.split(/[\s@.]+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase())
		.join("");

export const ShowUsers = ({
	view = "all",
	onViewChange,
	invitationCount = 0,
}: {
	view?: "all" | "pending";
	onViewChange?: (view: "all" | "pending") => void;
	invitationCount?: number;
}) => {
	const { active } = useOrganization();
	const members = useQuery(api.account.members, {
		organizationId: active.id,
	});
	const [query, setQuery] = useState("");
	const needle = query.trim().toLowerCase();
	const data = members
		?.filter(
			(member) =>
				!needle ||
				member.email.toLowerCase().includes(needle) ||
				(member.name ?? "").toLowerCase().includes(needle),
		)
		.map((member) => ({
			id: member.id,
			role: member.role,
			createdAt: member.createdAt,
			user: {
				id: member.userId,
				email: member.email,
				name: member.name,
				image: member.image,
				twoFactorEnabled: member.twoFactorEnabled,
				banned: member.banned,
			},
		}));
	const isPending = members === undefined;
	const [isRemoving, setIsRemoving] = useState(false);
	const setDeactivated = useMutation(api.users.setDeactivated);
	const removeAccount = useMutation(api.users.removeAccount);
	const instanceAdmin = useIsInstanceAdmin();
	const permissions = usePermissions();
	const currentUser = useCurrentUser();
	const session = currentUser ? { user: { id: currentUser.id } } : undefined;

	return (
		<div className="flex w-full flex-col gap-6">
			<PageHeader
				title="Members"
				description="Who can sign in, and which projects and sections they can use."
			>
				{permissions.member.create ? <AddInvitation /> : null}
			</PageHeader>
			<div className="flex flex-col gap-4">
				<div className="flex flex-wrap items-center gap-3">
					<div className="relative w-full max-w-xs">
						<SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Search by name or email"
							className="pl-9"
							aria-label="Search members"
						/>
					</div>
					{onViewChange && invitationCount > 0 ? (
						<Tabs
							value={view}
							onValueChange={(next) => onViewChange(next as "all" | "pending")}
						>
							<TabsList aria-label="Show">
								<TabsTrigger value="all">
									Members
									<span className="font-normal text-muted-foreground tabular-nums">
										{members?.length ?? ""}
									</span>
								</TabsTrigger>
								<TabsTrigger value="pending">
									Invitations
									<span className="font-normal text-muted-foreground tabular-nums">
										{invitationCount}
									</span>
								</TabsTrigger>
							</TabsList>
						</Tabs>
					) : null}
				</div>
				{view === "pending" ? (
					<ShowInvitations search={needle} />
				) : isPending ? (
					<p className="py-3 text-muted-foreground text-sm">Loading…</p>
				) : data?.length === 0 ? (
					needle ? (
						<p className="py-3 text-muted-foreground text-sm">
							No members match “{query.trim()}”.
						</p>
					) : (
						<EmptyState
							icon={Users}
							title="No members yet"
							description="Invite people to work in this organization."
						/>
					)
				) : (
					<ResourceTable
						headers={
							<>
								<Th>Member</Th>
								<Th>Role</Th>
								<Th>Access</Th>
								<Th>Status</Th>
								<Th>2FA</Th>
								<Th className="max-2xl:hidden">Joined</Th>
								<Th className="w-12" />
							</>
						}
					>
						{data?.map((member) => {
							const currentUserRole = data?.find(
								(m) => m.user.id === session?.user?.id,
							)?.role;

							// Owners and admins hold every permission already.
							const isStaticAdminOrOwner =
								member.role === "owner" || member.role === "admin";
							const canEditPermissions =
								!isStaticAdminOrOwner &&
								member.user.id !== session?.user?.id &&
								permissions.member.update;

							// Can change role based on hierarchy:
							// - Owner: Can change anyone's role (except themselves and other owners)
							// - Admin: Can only change member/custom roles (not other admins or owners)
							// - Owner role is nontransferable
							const canChangeRole =
								member.role !== "owner" &&
								member.user.id !== session?.user?.id &&
								(currentUserRole === "owner" ||
									(currentUserRole === "admin" && member.role !== "admin"));

							const canDeleteMember = permissions?.member.delete ?? false;

							const canDelete =
								member.role !== "owner" &&
								member.user.id !== session?.user?.id &&
								(currentUserRole === "owner" ||
									(currentUserRole === "admin" && member.role !== "admin") ||
									(canDeleteMember && !isStaticAdminOrOwner));

							// Deactivation and account deletion are
							// account-wide; the backend also refuses users
							// who belong to other organizations unless the
							// caller administers the instance.
							const canChangeStatus =
								member.user.id !== session?.user?.id &&
								(instanceAdmin ||
									(member.role !== "owner" &&
										(currentUserRole === "owner" ||
											(currentUserRole === "admin" &&
												member.role === "member"))));

							const canDeleteAccount =
								instanceAdmin &&
								member.role !== "owner" &&
								member.user.id !== session?.user?.id;

							const hasAnyAction =
								canEditPermissions ||
								canChangeRole ||
								canDelete ||
								canChangeStatus ||
								canDeleteAccount;

							return (
								<TableRow key={member.id}>
									<TableCell>
										<div className="flex items-center gap-3">
											<Avatar className="size-7">
												{member.user.image ? (
													<AvatarImage src={member.user.image} alt="" />
												) : null}
												<AvatarFallback className="text-[11px]">
													{initials(member.user.name || member.user.email)}
												</AvatarFallback>
											</Avatar>
											<div className="flex min-w-0 max-w-64 flex-col">
												<span className="truncate font-medium">
													{member.user.name || member.user.email}
													{member.user.id === session?.user?.id && (
														<span className="ml-1 font-normal text-muted-foreground">
															· you
														</span>
													)}
												</span>
												{member.user.name ? (
													<span className="truncate text-[13px] text-muted-foreground">
														{member.user.email}
													</span>
												) : null}
											</div>
										</div>
									</TableCell>
									<TableCell>
										<span className="capitalize">{member.role}</span>
									</TableCell>
									<TableCell className="text-muted-foreground">
										{member.role === "owner" ? (
											"Everything"
										) : member.role === "admin" ? (
											"All projects and servers"
										) : canEditPermissions ? (
											<Link
												href={`/settings/members/${member.user.id}`}
												className="text-foreground underline-offset-4 hover:underline"
											>
												Granted projects · Edit
											</Link>
										) : (
											"Granted projects"
										)}
									</TableCell>
									<TableCell>
										<StatusDot
											tone={member.user.banned ? "destructive" : "success"}
										>
											{member.user.banned ? "Deactivated" : "Active"}
										</StatusDot>
									</TableCell>
									<TableCell
										className={
											member.user.twoFactorEnabled
												? undefined
												: "text-muted-foreground"
										}
									>
										{member.user.twoFactorEnabled ? "On" : "Off"}
									</TableCell>
									<TableCell className="max-2xl:hidden">
										<span className="whitespace-nowrap text-muted-foreground">
											{format(new Date(member.createdAt), "PP")}
										</span>
									</TableCell>

									<TableCell className="text-right">
										{hasAnyAction ? (
											<DropdownMenu>
												<DropdownMenuTrigger
													render={<Button variant="ghost" size="icon-sm" />}
												>
													<span className="sr-only">Open menu</span>
													<MoreHorizontal />
												</DropdownMenuTrigger>
												<DropdownMenuContent align="end" className="min-w-48">
													{canChangeRole && (
														<ChangeRole
															memberId={member.id}
															currentRole={member.role}
															userEmail={member.user.email}
														/>
													)}

													{canEditPermissions && (
														<DropdownMenuItem
															nativeButton={false}
															render={
																<Link
																	href={`/settings/members/${member.user.id}`}
																/>
															}
														>
															Edit access
														</DropdownMenuItem>
													)}
													{canChangeStatus && (
														<ResetPasswordLink
															userId={member.user.id}
															userEmail={member.user.email}
														/>
													)}
													{canChangeStatus && (
														<DialogAction
															title={
																member.user.banned
																	? "Reactivate User"
																	: "Deactivate User"
															}
															description={
																member.user.banned
																	? "The user will be able to sign in again."
																	: "The user will be signed out everywhere and won't be able to sign in until reactivated."
															}
															type={
																member.user.banned ? "default" : "destructive"
															}
															onClick={async () => {
																await setDeactivated({
																	organizationId: active.id,
																	userId: member.user.id,
																	deactivated: !member.user.banned,
																})
																	.then(() => {
																		toast.success(
																			member.user.banned
																				? "User reactivated"
																				: "User deactivated",
																		);
																	})
																	.catch((err) => {
																		toast.error(errorMessage(err));
																	});
															}}
														>
															<DropdownMenuItem closeOnClick={false}>
																{member.user.banned
																	? "Reactivate User"
																	: "Deactivate User"}
															</DropdownMenuItem>
														</DialogAction>
													)}

													{canDelete && (
														<DialogAction
															title="Delete User"
															description="Are you sure you want to remove this user from the organization?"
															type="destructive"
															disabled={isRemoving}
															onClick={async () => {
																setIsRemoving(true);
																await authResult(
																	authClient.organization.removeMember({
																		memberIdOrEmail: member.id,
																		organizationId: active.id,
																	}),
																)
																	.then(() => {
																		toast.success("User deleted successfully");
																	})
																	.catch((err) => {
																		toast.error(errorMessage(err));
																	})
																	.finally(() => setIsRemoving(false));
															}}
														>
															<DropdownMenuItem
																variant="destructive"
																closeOnClick={false}
															>
																Delete User
															</DropdownMenuItem>
														</DialogAction>
													)}

													{canDeleteAccount && (
														<DialogAction
															title="Delete Account"
															description="Are you sure you want to delete this user's account? It is removed from every organization and can't be restored."
															type="destructive"
															onClick={async () => {
																await removeAccount({
																	userId: member.user.id,
																})
																	.then(() => {
																		toast.success(
																			"Account deleted successfully",
																		);
																	})
																	.catch((err) => {
																		toast.error(errorMessage(err));
																	});
															}}
														>
															<DropdownMenuItem
																variant="destructive"
																closeOnClick={false}
															>
																Delete Account
															</DropdownMenuItem>
														</DialogAction>
													)}
												</DropdownMenuContent>
											</DropdownMenu>
										) : (
											<span className="sr-only">No actions available</span>
										)}
									</TableCell>
								</TableRow>
							);
						})}
					</ResourceTable>
				)}
			</div>
		</div>
	);
};
