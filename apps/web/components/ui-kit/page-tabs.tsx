"use client";

import { CheckIcon, ChevronDownIcon, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLayoutEffect, useRef, useState } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useShortcut } from "@/lib/dashboard/use-shortcut";
import { activeTab } from "@/lib/navigation";
import { cn } from "@/lib/utils";

export type PageTab = {
	title: string;
	href: string;
	icon?: LucideIcon;
	/** What a trailing dot stands for ("Changes waiting for a deploy"). */
	dot?: string;
};

// Tabs are 20px apart; the menu's chevron and its gap add 20px to a name.
const GAP = 20;
const CHEVRON = 20;
const label =
	"inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-medium";

// The number keys open the page's tabs in order.
function TabShortcut({ index, href }: { index: number; href: string }) {
	const router = useRouter();
	useShortcut(String(index + 1), () => router.push(href));
	return null;
}

function TabLabel({ tab }: { tab: PageTab }) {
	return (
		<>
			{tab.icon ? <tab.icon className="size-3.5 shrink-0" /> : null}
			{tab.title}
			{tab.dot ? (
				<span
					role="img"
					aria-label={tab.dot}
					className="size-1.5 shrink-0 rounded-full bg-warning"
				/>
			) : null}
		</>
	);
}

/** The sections of a page as a row of links under its header: one hairline,
    the open section underlined. A page under a section (a deployment, a
    container) keeps that section's tab. Tabs that don't fit the row move
    into a "More" menu at its end, which takes the name of the open section
    when that is one of them, so the row never scrolls and never widens the
    page. A single tab shows no row. Filters inside a page use the pill
    `Tabs` instead. */
export function PageTabs({
	label: name,
	tabs,
	className,
}: {
	/** Names the row for assistive tech ("Service sections"). */
	label: string;
	tabs: readonly PageTab[];
	className?: string;
}) {
	const pathname = usePathname();
	const current = activeTab(pathname, tabs)?.href ?? null;
	const row = useRef<HTMLDivElement>(null);
	const sizer = useRef<HTMLDivElement>(null);
	const [fit, setFit] = useState(tabs.length);
	const shape = tabs.map((tab) => `${tab.title}${tab.dot ? "•" : ""}`).join();

	// `shape` stands for the tabs' widths: the array itself is new every render.
	useLayoutEffect(() => {
		const measure = () => {
			if (!row.current || !sizer.current) return;
			const widths = Array.from(sizer.current.children, (child) =>
				Math.ceil(child.getBoundingClientRect().width),
			);
			const more = widths.pop() ?? 0;
			const available = row.current.clientWidth;
			const all = widths.reduce((sum, width) => sum + width, 0);
			if (all + GAP * (widths.length - 1) <= available) {
				setFit(widths.length);
				return;
			}
			// The most tabs that leave room for the menu's button, which is as
			// wide as "More" or as the widest name it may have to show.
			let count = widths.length - 1;
			for (; count > 0; count--) {
				const shown = widths.slice(0, count);
				const button = Math.max(
					more,
					...widths.slice(count).map((width) => width + CHEVRON),
				);
				const used = shown.reduce((sum, width) => sum + width + GAP, 0);
				if (used + button <= available) break;
			}
			setFit(count);
		};
		measure();
		const observer = new ResizeObserver(measure);
		if (row.current) observer.observe(row.current);
		// Widths change once the web font is in.
		void document.fonts?.ready.then(measure);
		return () => observer.disconnect();
	}, [shape]);

	if (tabs.length < 2) return null;

	const shown = tabs.slice(0, fit);
	const rest = tabs.slice(fit);
	const hiddenCurrent = rest.find((tab) => tab.href === current);

	return (
		<Tabs
			value={hiddenCurrent ? null : current}
			className={cn("gap-0 border-border border-b max-md:-mx-6", className)}
		>
			{tabs.slice(0, 9).map((tab, index) => (
				<TabShortcut key={tab.href} index={index} href={tab.href} />
			))}
			<div className="max-md:px-6">
				<div ref={row} className="relative -mb-px flex min-w-0 gap-5">
					{/* Every tab and the menu's button at their natural width. */}
					<div
						ref={sizer}
						aria-hidden
						className="pointer-events-none invisible absolute top-0 left-0 flex h-0 overflow-hidden"
					>
						{tabs.map((tab) => (
							<span key={tab.href} className={label}>
								<TabLabel tab={tab} />
							</span>
						))}
						<span className={label}>
							More
							<ChevronDownIcon className="size-3.5 shrink-0" />
						</span>
					</div>
					<TabsList
						variant="line"
						aria-label={name}
						className="flex min-w-0 gap-5 overflow-hidden"
					>
						{shown.map((tab) => (
							<TabsTrigger
								key={tab.href}
								value={tab.href}
								nativeButton={false}
								aria-current={tab.href === current ? "page" : undefined}
								render={<Link href={tab.href} />}
								className="h-10 flex-none gap-1.5 focus-visible:-outline-offset-2 group-data-[variant=line]/tabs-list:rounded-none group-data-[variant=line]/tabs-list:px-0 group-data-horizontal/tabs:after:bottom-0"
							>
								<TabLabel tab={tab} />
							</TabsTrigger>
						))}
					</TabsList>
					{rest.length > 0 ? (
						<DropdownMenu>
							<DropdownMenuTrigger
								aria-label={
									hiddenCurrent
										? `${hiddenCurrent.title}, more sections`
										: "More sections"
								}
								className={cn(
									label,
									"relative h-10 flex-none text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-popup-open:text-foreground",
									hiddenCurrent &&
										"text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary",
								)}
							>
								{hiddenCurrent ? <TabLabel tab={hiddenCurrent} /> : "More"}
								<ChevronDownIcon className="size-3.5 shrink-0" />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="min-w-44">
								{rest.map((tab) => (
									<DropdownMenuItem
										key={tab.href}
										autoIcon={false}
										render={<Link href={tab.href} />}
									>
										{tab.icon ? <tab.icon /> : null}
										<span className="min-w-0 flex-1 truncate">{tab.title}</span>
										{tab.dot ? (
											<span
												role="img"
												aria-label={tab.dot}
												className="size-1.5 shrink-0 rounded-full bg-warning"
											/>
										) : null}
										<CheckIcon
											className={cn(
												"size-3.5 text-muted-foreground",
												tab.href !== current && "invisible",
											)}
										/>
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
					) : null}
				</div>
			</div>
		</Tabs>
	);
}
