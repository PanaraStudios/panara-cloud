"use client";

import { usePathname, useSearchParams } from "next/navigation";
import type { ComponentType } from "react";
import { createContext, useContext, useState } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useShortcut } from "@/lib/dashboard/use-shortcut";
import { cn } from "@/lib/utils";

// A Settings page with sections (a service's, a server's): the list of
// sections stays on the left, the open one fills the rest. `SettingsLayout`
// is the frame, each `SettingsPane` one section.

export type SettingsNavItem = {
	id: string;
	title: string;
	href: string;
	icon: ComponentType<{ className?: string }>;
	/** What a dot after the title stands for ("Changes not deployed"). */
	dot?: string;
};

const ActiveSection = createContext<string | null>(null);
// The layout's items, so a pane's title carries the glyph its row in the
// list has.
const Sections = createContext<readonly SettingsNavItem[]>([]);

/** The open section's id inside a `SettingsLayout`, null outside one. */
export const useActiveSection = () => useContext(ActiveSection);

/** For a Settings page that is one route: the open section lives in
    `?section=`. Returns the open id and the link to each section. */
export function useQuerySection(ids: readonly string[]) {
	const pathname = usePathname();
	const requested = useSearchParams().get("section");
	const active =
		requested && ids.includes(requested) ? requested : (ids[0] ?? "");
	return [active, (id: string) => `${pathname}?section=${id}`] as const;
}

// Moves the URL without a navigation, which would remount the page and drop
// unsaved edits; `usePathname` follows it.
const open = (href: string) => {
	window.history.pushState(null, "", href);
	window.scrollTo({ top: 0 });
};

/** The sections as a list beside the open one. On a phone the list is one
    select above it. */
export function SettingsLayout({
	label,
	items,
	active,
	children,
}: {
	/** Names the list for assistive tech ("Settings sections"). */
	label: string;
	items: readonly SettingsNavItem[];
	active: string;
	children: React.ReactNode;
}) {
	const step = (by: 1 | -1) => {
		const next = items[items.findIndex((item) => item.id === active) + by];
		if (!next) return false;
		open(next.href);
	};
	useShortcut("[", () => step(-1));
	useShortcut("]", () => step(1));
	// One section needs no list.
	if (items.length < 2) {
		return (
			<Sections value={items}>
				<ActiveSection value={active}>
					<div className="w-full min-w-0 pb-16">{children}</div>
				</ActiveSection>
			</Sections>
		);
	}
	return (
		<div className="grid w-full min-w-0 gap-x-10 gap-y-6 pb-16 md:grid-cols-[13rem_minmax(0,1fr)]">
			<Select
				value={active}
				onValueChange={(id) => {
					const item = items.find((entry) => entry.id === id);
					if (item) open(item.href);
				}}
			>
				<SelectTrigger aria-label={label} className="w-full md:hidden">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{items.map((item) => (
						<SelectItem key={item.id} value={item.id}>
							<item.icon className="text-muted-foreground" />
							{item.title}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<nav
				aria-label={label}
				className="sticky top-6 isolate flex flex-col gap-0.5 self-start max-md:hidden"
			>
				{/* The pill behind the open section; rows are 32px, 2px apart. */}
				<span
					aria-hidden
					className="absolute inset-x-0 top-0 -z-10 h-8 rounded-lg bg-muted transition-transform duration-200 ease-(--ease-out) motion-reduce:transition-none"
					style={{
						transform: `translateY(${items.findIndex((item) => item.id === active) * 34}px)`,
					}}
				/>
				{items.map((item) => {
					const current = item.id === active;
					return (
						<a
							key={item.id}
							href={item.href}
							aria-current={current ? "page" : undefined}
							className={cn(
								"flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
								current
									? "font-medium text-foreground"
									: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
							)}
							onClick={(event) => {
								if (event.metaKey || event.ctrlKey || event.shiftKey) return;
								event.preventDefault();
								if (!current) open(item.href);
							}}
						>
							<item.icon className="size-4 shrink-0" />
							<span className="min-w-0 flex-1 truncate">{item.title}</span>
							{item.dot ? (
								<span
									role="img"
									aria-label={item.dot}
									className="size-1.5 shrink-0 rounded-full bg-warning"
								/>
							) : null}
						</a>
					);
				})}
			</nav>
			<Sections value={items}>
				<ActiveSection value={active}>
					<div className="min-w-0">{children}</div>
				</ActiveSection>
			</Sections>
		</div>
	);
}

/** One section: title, one line, an optional notice, then its body. It
    mounts the first time it is opened and stays mounted behind the others,
    so unsaved edits survive a look at another section. */
export function SettingsPane({
	id,
	title,
	description,
	notice,
	actions,
	children,
}: {
	id: string;
	title: string;
	description?: React.ReactNode;
	notice?: React.ReactNode;
	/** Buttons at the end of the title row ("New environment"). */
	actions?: React.ReactNode;
	children: React.ReactNode;
}) {
	const active = useActiveSection() === id;
	const Icon = useContext(Sections).find((item) => item.id === id)?.icon;
	const [opened, setOpened] = useState(active);
	if (active && !opened) setOpened(true);
	if (!opened) return null;
	return (
		<section
			id={id}
			hidden={!active}
			aria-labelledby={`${id}-title`}
			className={cn(
				"min-w-0 flex-col gap-6",
				active &&
					"flex motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:animate-in motion-safe:duration-200",
			)}
		>
			<div className="flex min-w-0 items-start justify-between gap-4">
				<div className="flex min-w-0 flex-col gap-1">
					<h2
						id={`${id}-title`}
						className="flex items-center gap-2 font-semibold text-[17px] leading-snug"
					>
						{Icon ? (
							<Icon className="size-4 shrink-0 text-muted-foreground" />
						) : null}
						{title}
					</h2>
					{description ? (
						<p className="text-muted-foreground text-sm">{description}</p>
					) : null}
					{notice}
				</div>
				{actions ? (
					<div className="flex shrink-0 items-center gap-2">{actions}</div>
				) : null}
			</div>
			<div className="min-w-0">{children}</div>
		</section>
	);
}
