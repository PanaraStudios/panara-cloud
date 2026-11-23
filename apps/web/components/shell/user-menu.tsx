"use client";

import {
	Building2Icon,
	LogOutIcon,
	MonitorIcon,
	MoonIcon,
	SunIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useState } from "react";
import { AddOrganization } from "@/components/dashboard/organization/handle-organization";
import { signOutTo } from "@/components/sign-out-button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { ConfirmDialog } from "@/components/ui-kit/primitives";
import { accountNav } from "@/lib/navigation";
import { useIsInstanceAdmin, useOrganization } from "@/lib/organization";
import Link from "@/lib/router/link";

export type MenuAccount = { name: string; email: string; image: string | null };

function initials(account: MenuAccount) {
	const source = account.name.trim() || account.email;
	return source
		.split(/[\s@.]+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase())
		.join("");
}

const APPEARANCE_OPTIONS = [
	{ theme: "light", label: "Light", Icon: SunIcon },
	{ theme: "dark", label: "Dark", Icon: MoonIcon },
	{ theme: "system", label: "System", Icon: MonitorIcon },
] as const;

/* Menu radio items so arrow keys, Enter, and assistive tech all reach them.
   The menu stays open so the change is visible before it closes. */
function AppearanceItems() {
	const { theme, setTheme } = useTheme();
	return (
		<DropdownMenuGroup>
			<DropdownMenuLabel>Appearance</DropdownMenuLabel>
			<DropdownMenuRadioGroup
				value={theme ?? ""}
				onValueChange={(next) => setTheme(String(next))}
			>
				{APPEARANCE_OPTIONS.map(({ theme: value, label, Icon }) => (
					<DropdownMenuRadioItem key={value} value={value} closeOnClick={false}>
						<Icon />
						{label}
					</DropdownMenuRadioItem>
				))}
			</DropdownMenuRadioGroup>
		</DropdownMenuGroup>
	);
}

function AccountAvatar({
	account,
	size,
}: {
	account: MenuAccount;
	size?: "sm";
}) {
	return (
		<Avatar size={size}>
			{account.image && <AvatarImage src={account.image} alt="" />}
			<AvatarFallback>{initials(account)}</AvatarFallback>
		</Avatar>
	);
}

// opensend's avatar menu in the sidebar footer: who you are, personal pages,
// appearance and log out (confirmed).
export function UserMenu({ account }: { account: MenuAccount }) {
	const { organizations } = useOrganization();
	const instanceAdmin = useIsInstanceAdmin();
	const [logoutOpen, setLogoutOpen] = useState(false);
	const [addOrganizationOpen, setAddOrganizationOpen] = useState(false);
	// With one organization the switcher is hidden, so its "Add organization"
	// lives here for the instance admin.
	const canAddOrganization = instanceAdmin && organizations.length === 1;

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<SidebarMenuButton
							size="icon"
							tooltip={account.name || "Account"}
							className="overflow-hidden rounded-full"
							aria-label="Account menu"
						/>
					}
				>
					<AccountAvatar account={account} />
					<span className="sr-only">{account.email}</span>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" side="top" className="w-56">
					<DropdownMenuGroup>
						<DropdownMenuLabel className="p-0 font-normal text-foreground">
							<span className="flex items-center gap-2 px-1.5 py-1.5">
								<AccountAvatar account={account} size="sm" />
								<span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
									<span className="truncate font-medium">
										{account.name || "You"}
									</span>
									<span className="truncate font-mono text-caption text-muted-foreground">
										{account.email}
									</span>
								</span>
							</span>
						</DropdownMenuLabel>
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<DropdownMenuGroup>
						{accountNav.map(({ url, title, icon: Icon }) => (
							<DropdownMenuItem key={url} render={<Link href={url} />}>
								<Icon />
								{title}
							</DropdownMenuItem>
						))}
						{canAddOrganization && (
							<DropdownMenuItem onClick={() => setAddOrganizationOpen(true)}>
								<Building2Icon />
								Add organization
							</DropdownMenuItem>
						)}
					</DropdownMenuGroup>
					<DropdownMenuSeparator />
					<AppearanceItems />
					<DropdownMenuSeparator />
					<DropdownMenuItem
						variant="destructive"
						onClick={() => setLogoutOpen(true)}
					>
						<LogOutIcon />
						Log out
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<ConfirmDialog
				open={logoutOpen}
				onOpenChange={setLogoutOpen}
				title="Log out?"
				description="You can sign in again at any time."
				confirmLabel="Log out"
				onConfirm={() => signOutTo()}
			/>
			{canAddOrganization && (
				<AddOrganization
					open={addOrganizationOpen}
					onOpenChange={setAddOrganizationOpen}
				/>
			)}
		</>
	);
}
