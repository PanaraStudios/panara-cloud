"use client";

import type { ComponentType } from "react";
import { useState } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
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
				className="sticky top-6 flex flex-col gap-0.5 self-start max-md:hidden"
			>
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
									? "bg-muted font-medium text-foreground"
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
			<div className="min-w-0">{children}</div>
		</div>
	);
}

/** One section: title, one line, an optional notice, then its body. It
    mounts the first time it is opened and stays mounted behind the others,
    so unsaved edits survive a look at another section. */
export function SettingsPane({
	id,
	active,
	title,
	description,
	notice,
	className,
	children,
}: {
	id: string;
	active: boolean;
	title: string;
	description?: React.ReactNode;
	notice?: React.ReactNode;
	/** For the body: `max-w-5xl` for a form. */
	className?: string;
	children: React.ReactNode;
}) {
	const [opened, setOpened] = useState(active);
	if (active && !opened) setOpened(true);
	if (!opened) return null;
	return (
		<section
			id={id}
			hidden={!active}
			aria-labelledby={`${id}-title`}
			className={cn("min-w-0 flex-col gap-6", active && "flex")}
		>
			<div className="flex min-w-0 flex-col gap-1">
				<h2
					id={`${id}-title`}
					className="font-semibold text-[17px] leading-snug"
				>
					{title}
				</h2>
				{description ? (
					<p className="text-muted-foreground text-sm">{description}</p>
				) : null}
				{notice}
			</div>
			<div className={cn("min-w-0", className)}>{children}</div>
		</section>
	);
}
