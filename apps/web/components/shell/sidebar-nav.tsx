"use client";

import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useState } from "react";
import {
	SidebarMenuAction,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
	useSidebar,
} from "@/components/ui/sidebar";
import {
	isActive,
	type NavItem,
	orgNav,
	settingsNav,
	sidebarState,
	visibleItems,
} from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { NavigationKeys } from "./shortcuts-dialog";

// The sidebar's items, the same on every page: Projects · Activity ·
// Servers · Settings. Settings opens in place and lists its pages; nothing
// else is ever added here (a project, a service or a server shows where it is
// in the page's breadcrumb and its sections as tabs).

const SETTINGS_OPEN_KEY = "panara-cloud:sidebar-settings-open";

/** Opens on entering Settings; elsewhere it keeps the member's last choice.
    The chevron closes and opens it on any page. */
function useSettingsOpen(inSettings: boolean) {
	const [stored, setStored] = useState(false);
	const [closedHere, setClosedHere] = useState(false);
	useEffect(() => {
		try {
			setStored(window.localStorage.getItem(SETTINGS_OPEN_KEY) === "1");
		} catch {}
	}, []);
	useEffect(() => {
		if (!inSettings) setClosedHere(false);
	}, [inSettings]);
	const open = inSettings ? !closedHere : stored;
	const toggle = () => {
		const next = !open;
		setStored(next);
		setClosedHere(inSettings && !next);
		try {
			window.localStorage.setItem(SETTINGS_OPEN_KEY, next ? "1" : "0");
		} catch {}
	};
	return [open, toggle] as const;
}

function NavButton({
	item,
	href = item.url,
	state,
}: {
	item: NavItem;
	href?: string;
	state: "current" | "ancestor" | undefined;
}) {
	return (
		<SidebarMenuButton
			isActive={state === "current"}
			aria-current={state === "current" ? "page" : undefined}
			className={
				state === "ancestor" ? "font-medium text-foreground" : undefined
			}
			tooltip={{
				// A shortcut is worth a tooltip next to its label too.
				...(item.shortcut ? { hidden: false } : null),
				children: (
					<>
						{item.title}
						<NavigationKeys shortcut={item.shortcut} />
					</>
				),
			}}
			render={<Link href={href} />}
		>
			<item.icon />
			<span className="min-w-0 flex-1 truncate">{item.title}</span>
		</SidebarMenuButton>
	);
}

function SettingsItem({ item }: { item: NavItem }) {
	const pathname = usePathname();
	const permissions = usePermissions();
	const groups = settingsNav
		.map((group) => ({
			label: group.label,
			items: visibleItems(group.items, permissions),
		}))
		.filter((group) => group.items.length > 0);
	const state = sidebarState(pathname, item);
	const [open, toggle] = useSettingsOpen(state !== undefined);
	const collapsed = useSidebar().state === "collapsed";
	return (
		<SidebarMenuItem>
			<NavButton
				item={item}
				href={groups[0]?.items[0]?.url ?? item.url}
				// With its list out of sight, the row stands for the page open
				// under it.
				state={state && (!open || collapsed) ? "current" : state}
			/>
			<SidebarMenuAction
				aria-label={open ? "Hide settings pages" : "Show settings pages"}
				aria-expanded={open}
				className="text-muted-foreground"
				onClick={toggle}
			>
				<ChevronRightIcon
					className={cn("transition-transform", open && "rotate-90")}
				/>
			</SidebarMenuAction>
			{open ? (
				<SidebarMenuSub
					aria-label="Settings pages"
					className="mt-1 mr-0 gap-0.5 pr-0"
				>
					{groups.map((group) => (
						<Fragment key={group.label}>
							<li
								aria-hidden
								className="px-2 pt-2 pb-0.5 text-[11px] text-muted-foreground/80 leading-4 first:pt-0.5"
							>
								{group.label}
							</li>
							{group.items.map((child) => {
								const current = isActive(pathname, child.url);
								return (
									<SidebarMenuSubItem key={child.url}>
										<SidebarMenuSubButton
											isActive={current}
											aria-current={current ? "page" : undefined}
											render={<Link href={child.url} />}
										>
											<span>{child.title}</span>
										</SidebarMenuSubButton>
									</SidebarMenuSubItem>
								);
							})}
						</Fragment>
					))}
				</SidebarMenuSub>
			) : null}
		</SidebarMenuItem>
	);
}

export function SidebarNav() {
	const pathname = usePathname();
	const permissions = usePermissions();
	return visibleItems(orgNav, permissions).map((item) =>
		item.url === "/settings" ? (
			<SettingsItem key={item.url} item={item} />
		) : (
			<SidebarMenuItem key={item.url}>
				<NavButton item={item} state={sidebarState(pathname, item)} />
			</SidebarMenuItem>
		),
	);
}
