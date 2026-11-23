"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { ChevronsUpDownIcon, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AddOrganization } from "@/components/dashboard/organization/handle-organization";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { SidebarMenuButton, useSidebar } from "@/components/ui/sidebar";
import { authClient, authResult } from "@/lib/auth/client";
import { errorMessage } from "@/lib/auth/errors";
import {
	type Organization,
	useIsInstanceAdmin,
	useOrganization,
} from "@/lib/organization";
import { cn } from "@/lib/utils";

// opensend's TeamGlyph: the logo, else the initial on an icon tile.
export function OrganizationMark({
	organization,
	className,
}: {
	organization: Pick<Organization, "name" | "logo">;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"icon-tile size-7 overflow-hidden rounded-lg text-xs font-semibold",
				className,
			)}
		>
			{organization.logo ? (
				<img
					src={organization.logo}
					alt=""
					className="size-full object-cover"
				/>
			) : (
				(organization.name.trim()[0]?.toUpperCase() ?? "?")
			)}
		</span>
	);
}

// The organization selector (search, switch, set default, edit and
// delete for owners, add for the instance admin) in opensend's team switcher
// chrome. The shell hides it while there is only one organization.
export function OrganizationSwitcher() {
	const { organizations, active, switchTo } = useOrganization();
	const instanceAdmin = useIsInstanceAdmin();
	const { isMobile } = useSidebar();
	const [open, setOpen] = useState(false);
	const [removingId, setRemovingId] = useState<string | null>(null);
	const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);
	const setDefaultOrganization = useMutation(
		api.account.setDefaultOrganization,
	);
	const ownedCount = organizations.filter((org) => org.role === "owner").length;

	const deleteOrganization = async (organizationId: string) => {
		if (ownedCount <= 1) {
			toast.error(
				"You must maintain at least one organization where you are the owner",
			);
			return;
		}
		setRemovingId(organizationId);
		try {
			await authResult(authClient.organization.delete({ organizationId }));
			toast.success("Organization deleted successfully");
		} catch (error) {
			toast.error(errorMessage(error) || "Error deleting organization");
		} finally {
			setRemovingId(null);
		}
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<SidebarMenuButton
						size="lg"
						className="h-10 text-foreground"
						aria-label={`Organization: ${active.name}. Switch organization`}
					/>
				}
			>
				<OrganizationMark organization={active} />
				<span className="min-w-0 flex-1 truncate text-left font-semibold text-sm tracking-tight">
					{active.name}
				</span>
				<ChevronsUpDownIcon className="ml-auto size-4 text-muted-foreground" />
			</PopoverTrigger>
			<PopoverContent
				className="w-80 p-0"
				align="start"
				side={isMobile ? "bottom" : "right"}
				sideOffset={8}
			>
				<Command>
					<CommandInput placeholder="Search organizations..." className="h-9" />
					<CommandList className="max-h-[min(60vh,24rem)]">
						<CommandEmpty>No organizations found.</CommandEmpty>
						<CommandGroup heading="Organizations">
							{organizations.map((org) => (
								<CommandItem
									key={org.id}
									value={`${org.name} ${org.id}`}
									onSelect={() => {
										setOpen(false);
										if (org.id === active.id) return;
										switchTo(org.id).catch(() =>
											toast.error("Couldn't switch organization"),
										);
									}}
									className="flex items-center justify-between gap-1"
								>
									<div className="flex min-w-0 flex-1 items-center gap-2">
										<OrganizationMark
											organization={org}
											className="size-6 text-[10px]"
										/>
										<span
											className={cn(
												"truncate",
												org.id === active.id && "font-medium",
											)}
										>
											{org.name}
										</span>
									</div>

									<div
										className="flex shrink-0 items-center gap-2"
										onClick={(e) => e.stopPropagation()}
										onKeyDown={(e) => e.stopPropagation()}
									>
										<Button
											variant="ghost"
											size="icon"
											className="group"
											isLoading={settingDefaultId === org.id}
											disabled={org.isDefault}
											onClick={async (e) => {
												if (org.isDefault) return;
												e.stopPropagation();
												setSettingDefaultId(org.id);
												await setDefaultOrganization({ organizationId: org.id })
													.then(() => {
														toast.success("Default organization updated");
													})
													.catch((error) => {
														toast.error(
															errorMessage(error) ||
																"Error setting default organization",
														);
													})
													.finally(() => setSettingDefaultId(null));
											}}
											title={
												org.isDefault
													? "Default organization"
													: "Set as default"
											}
										>
											{org.isDefault ? (
												<Star
													fill="currentColor"
													className="size-4 text-foreground"
												/>
											) : (
												<Star
													fill="none"
													className="size-4 text-muted-foreground transition-colors group-hover:text-foreground"
												/>
											)}
										</Button>
										{org.role === "owner" && (
											<>
												<AddOrganization organizationId={org.id} />
												<DialogAction
													title="Delete Organization"
													description="Are you sure you want to delete this organization?"
													type="destructive"
													onClick={() => deleteOrganization(org.id)}
												>
													<Button
														variant="ghost"
														size="icon"
														className="group"
														isLoading={removingId === org.id}
													>
														<Trash2 className="size-4 text-muted-foreground group-hover:text-destructive" />
													</Button>
												</DialogAction>
											</>
										)}
									</div>
								</CommandItem>
							))}
						</CommandGroup>
					</CommandList>
					{instanceAdmin && (
						<div className="border-t p-1">
							<AddOrganization />
						</div>
					)}
				</Command>
			</PopoverContent>
		</Popover>
	);
}
