"use client";

import { SearchIcon, SearchXIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import {
	BackLink,
	EmptyState,
	PageHeader,
} from "@/components/ui-kit/primitives";
import { useShortcut } from "@/lib/dashboard/use-shortcut";
import { type NavItem, settingsNav, visibleItems } from "@/lib/navigation";
import { useIsInstanceAdmin } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";

// Settings is a hub: `/settings` lists every page the member can open, and a
// page opened from it starts with the way back. There is no second list.

function useSettingsGroups() {
	const permissions = usePermissions();
	const instanceAdmin = useIsInstanceAdmin();
	return settingsNav
		.map((group) => ({
			label: group.label ?? "",
			items: visibleItems(group.items, permissions, instanceAdmin),
		}))
		.filter((group) => group.items.length > 0);
}

/** Around every Settings page. One listed on the hub gets the link back to
    it; a page under one (a provider, "Connect provider") has its own way
    back to its parent. */
export function SettingsArea({ children }: { children: React.ReactNode }) {
	const pathname = usePathname();
	const router = useRouter();
	const pages = useSettingsGroups().flatMap((group) => group.items);
	const index = pages.findIndex((item) => item.url === pathname);
	const step = (by: 1 | -1) => {
		const next = pages[index + by];
		if (!next) return false;
		router.push(next.url);
	};
	useShortcut("[", () => step(-1), { enabled: index >= 0 });
	useShortcut("]", () => step(1), { enabled: index >= 0 });
	if (index < 0) return children;
	return (
		<div className="flex w-full min-w-0 flex-col gap-4">
			<BackLink href="/settings" label="Settings" />
			{children}
		</div>
	);
}

const PANEL_GROUP = "Panel";
// A member with a handful of pages needs no filter above them.
const MIN_TO_FILTER = 6;

const matches = (item: NavItem, group: string, needle: string) =>
	[item.title, item.description, group, ...(item.keywords ?? [])]
		.join(" ")
		.toLowerCase()
		.includes(needle);

/** `/settings`: every Settings page under its group. Typing filters; the
    arrows move through what is left and Enter opens it. */
export function SettingsHub() {
	const router = useRouter();
	const groups = useSettingsGroups();
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const [filter, setFilter] = useState("");
	const [cursor, setCursor] = useState<string | null>(null);
	const needle = filter.trim().toLowerCase();
	const shown = groups
		.map((group) => ({
			label: group.label,
			items: needle
				? group.items.filter((item) => matches(item, group.label, needle))
				: group.items,
		}))
		.filter((group) => group.items.length > 0);
	const flat = shown.flatMap((group) => group.items);
	const total = groups.reduce((sum, group) => sum + group.items.length, 0);
	// With something typed the first match is ready for Enter.
	const active =
		flat.find((item) => item.url === cursor) ?? (needle ? flat[0] : undefined);

	// A keyboard is at hand: typing filters at once. A phone would only get
	// its keyboard thrown over the list.
	useEffect(() => {
		if (window.matchMedia("(pointer: fine)").matches) {
			input.current?.focus({ preventScroll: true });
		}
	}, []);

	const move = (by: 1 | -1) => {
		if (flat.length === 0) return;
		const from = active ? flat.indexOf(active) : by === 1 ? -1 : 0;
		const next = flat[(from + by + flat.length) % flat.length];
		if (!next) return;
		setCursor(next.url);
		list.current
			?.querySelector(`[data-url="${next.url}"]`)
			?.scrollIntoView({ block: "nearest" });
	};

	return (
		<div className="flex w-full min-w-0 flex-col gap-6 pb-16">
			<PageHeader
				title="Settings"
				description={
					groups.some((group) => group.label === PANEL_GROUP)
						? "Your organization, what it connects to, and this panel."
						: "Your organization and what it connects to."
				}
			/>
			<InputGroup
				className={cn("w-full sm:w-80", total < MIN_TO_FILTER && "hidden")}
			>
				<InputGroupAddon>
					<SearchIcon />
				</InputGroupAddon>
				<InputGroupInput
					ref={input}
					placeholder="Filter settings"
					aria-label="Filter settings"
					aria-controls="settings-list"
					autoComplete="off"
					spellCheck={false}
					value={filter}
					onChange={(event) => {
						setFilter(event.target.value);
						setCursor(null);
					}}
					onKeyDown={(event) => {
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							move(event.key === "ArrowDown" ? 1 : -1);
						} else if (event.key === "Enter" && active) {
							event.preventDefault();
							router.push(active.url);
						} else if (event.key === "Escape") {
							if (filter) {
								setFilter("");
								setCursor(null);
							} else {
								event.currentTarget.blur();
							}
						}
					}}
				/>
				<InputGroupAddon align="inline-end">
					<Kbd>/</Kbd>
				</InputGroupAddon>
			</InputGroup>
			{shown.length === 0 ? (
				<EmptyState
					icon={SearchXIcon}
					title="No setting matches"
					description="Try another word, or press Esc to see them all."
				/>
			) : (
				<div id="settings-list" ref={list} className="flex flex-col gap-8">
					{shown.map((group) => (
						<section
							key={group.label}
							aria-label={group.label}
							className="flex min-w-0 flex-col gap-2"
						>
							<h2 className="border-border border-b pb-2 text-muted-foreground text-sm">
								{group.label}
							</h2>
							<ul className="grid grid-cols-[repeat(auto-fill,minmax(min(19rem,100%),1fr))] gap-x-6 gap-y-0.5">
								{group.items.map((item) => (
									<li key={item.url} className="min-w-0">
										<Link
											href={item.url}
											data-url={item.url}
											data-active={item === active ? "" : undefined}
											onMouseEnter={() => setCursor(item.url)}
											onMouseLeave={() => setCursor(null)}
											className={cn(
												"group -mx-2 flex items-center gap-3 rounded-lg px-2 py-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
												"data-active:bg-muted/70",
											)}
										>
											<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-data-active:bg-transparent group-data-active:text-foreground">
												<item.icon className="size-4" />
											</span>
											<span className="min-w-0 flex-1">
												<span className="block truncate font-medium text-sm">
													{item.title}
												</span>
												<span className="block truncate text-muted-foreground text-sm">
													{item.description}
												</span>
											</span>
										</Link>
									</li>
								))}
							</ul>
						</section>
					))}
				</div>
			)}
		</div>
	);
}
