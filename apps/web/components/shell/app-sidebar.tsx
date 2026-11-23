"use client";

import {
	KeyboardIcon,
	PanelLeftCloseIcon,
	PanelLeftOpenIcon,
	SearchIcon,
} from "lucide-react";
import { useEffect } from "react";
import { BrandMark } from "@/components/logo";
import { Kbd } from "@/components/ui/kbd";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
	useSidebar,
} from "@/components/ui/sidebar";
import { useShortcut, useShortcutModifier } from "@/lib/dashboard/use-shortcut";
import { useOrganization } from "@/lib/organization";
import { usePathname } from "@/lib/router";
import Link from "@/lib/router/link";
import { InvitationsBell } from "./invitations-bell";
import { OrganizationSwitcher } from "./org-switcher";
import { SidebarNav, SidebarSettings } from "./sidebar-nav";
import { type MenuAccount, UserMenu } from "./user-menu";

// opensend's dashboard sidebar (components/dashboard/shell.tsx). It is the
// same on every page: the brand or organization switcher, search, the items
// of lib/navigation.ts with the projects and servers under them, then
// Settings and the footer row.

function SidebarCollapseButton() {
	const { state, toggleSidebar } = useSidebar();
	const collapsed = state === "collapsed";
	const modifier = useShortcutModifier();
	useShortcut("mod+b", toggleSidebar);

	return (
		<SidebarMenuButton
			size="icon"
			className="text-muted-foreground"
			aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
			aria-keyshortcuts={modifier === "⌘" ? "Meta+B" : "Control+B"}
			tooltip={{
				children: (
					<>
						{collapsed ? "Expand" : "Collapse"}
						<Kbd>{modifier} B</Kbd>
					</>
				),
			}}
			onClick={toggleSidebar}
		>
			{collapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
		</SidebarMenuButton>
	);
}

// One organization: the product mark stands where the switcher would be.
function BrandButton() {
	return (
		<SidebarMenuButton
			size="lg"
			className="h-10 text-foreground"
			tooltip="Panara Cloud"
			render={<Link href="/" />}
		>
			<BrandMark />
			<span className="truncate font-semibold tracking-tight">
				Panara Cloud
			</span>
		</SidebarMenuButton>
	);
}

export function AppSidebar({
	account,
	onSearch,
	onShortcuts,
}: {
	account: MenuAccount;
	onSearch: () => void;
	onShortcuts: () => void;
}) {
	const modifier = useShortcutModifier();
	const { organizations } = useOrganization();
	const pathname = usePathname();
	const { setOpenMobile } = useSidebar();
	// A phone's sheet covers the page it just opened.
	useEffect(() => setOpenMobile(false), [pathname, setOpenMobile]);

	return (
		<Sidebar
			collapsible="icon"
			className="border-double-r bg-sidebar/90 backdrop-blur-md"
		>
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						{organizations.length > 1 ? (
							<OrganizationSwitcher />
						) : (
							<BrandButton />
						)}
					</SidebarMenuItem>
					<SidebarMenuItem>
						<SidebarMenuButton
							variant="outline"
							tooltip={{
								children: (
									<>
										Search <Kbd>{modifier} K</Kbd>
									</>
								),
							}}
							aria-keyshortcuts={modifier === "⌘" ? "Meta+K" : "Control+K"}
							onClick={onSearch}
						>
							<SearchIcon />
							<span>Search</span>
							<Kbd className="ml-auto px-1.5 group-data-[collapsible=icon]:hidden">
								<span>{modifier}</span>
								<span>K</span>
							</Kbd>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup className="pt-0">
					<SidebarGroupContent>
						<SidebarMenu>
							<SidebarNav />
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter>
				<SidebarMenu>
					<SidebarSettings />
					<SidebarMenuItem className="flex w-full flex-row items-center gap-1 group-data-[collapsible=icon]:flex-col">
						<UserMenu account={account} />
						<InvitationsBell />
						<span className="flex-1 group-data-[collapsible=icon]:hidden" />
						<SidebarMenuButton
							size="icon"
							className="text-muted-foreground"
							onClick={onShortcuts}
							aria-keyshortcuts="Shift+/"
							aria-label="Keyboard shortcuts"
							tooltip={{
								children: (
									<>
										Keyboard shortcuts <Kbd>?</Kbd>
									</>
								),
							}}
						>
							<KeyboardIcon />
						</SidebarMenuButton>
						<SidebarCollapseButton />
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	);
}
