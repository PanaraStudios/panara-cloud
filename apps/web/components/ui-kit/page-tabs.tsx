"use client";

import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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

const FADE = "1.5rem";

// The number keys open the page's tabs in order.
function TabShortcut({ index, href }: { index: number; href: string }) {
	const router = useRouter();
	useShortcut(String(index + 1), () => router.push(href));
	return null;
}

/** The sections of a page as a row of links under its header: one hairline,
    the open section underlined. A page under a section (a deployment, a
    container) keeps that section's tab. The row scrolls sideways when it
    doesn't fit, fading at the edge that hides more. A single tab shows no
    row. Filters inside a page use the pill `Tabs` instead. */
export function PageTabs({
	label,
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
	const [hidden, setHidden] = useState({ start: false, end: false });

	useEffect(() => {
		const list = row.current;
		if (!list) return;
		const measure = () => {
			const start = list.scrollLeft > 1;
			const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
			setHidden((previous) =>
				previous.start === start && previous.end === end
					? previous
					: { start, end },
			);
		};
		measure();
		list.addEventListener("scroll", measure, { passive: true });
		const observer = new ResizeObserver(measure);
		observer.observe(list);
		return () => {
			list.removeEventListener("scroll", measure);
			observer.disconnect();
		};
	}, []);

	// The open tab can sit outside a row that scrolls.
	useEffect(() => {
		const list = row.current;
		const tab = list?.querySelector<HTMLElement>("[aria-current=page]");
		if (!list || !tab || list.scrollWidth <= list.clientWidth) return;
		const offset =
			tab.getBoundingClientRect().left - list.getBoundingClientRect().left;
		list.scrollLeft += offset - (list.clientWidth - tab.offsetWidth) / 2;
	}, [current]);

	if (tabs.length < 2) return null;

	const mask =
		hidden.start || hidden.end
			? `linear-gradient(to right, ${hidden.start ? "transparent" : "black"}, black ${FADE}, black calc(100% - ${FADE}), ${hidden.end ? "transparent" : "black"})`
			: undefined;

	return (
		<Tabs
			value={current}
			className={cn("gap-0 border-border border-b max-md:-mx-6", className)}
		>
			{tabs.slice(0, 9).map((tab, index) => (
				<TabShortcut key={tab.href} index={index} href={tab.href} />
			))}
			<TabsList
				ref={row}
				variant="line"
				aria-label={label}
				style={{ maskImage: mask, WebkitMaskImage: mask }}
				className="-mb-px flex w-full gap-6 overflow-x-auto [scrollbar-width:none] max-md:px-6 [&::-webkit-scrollbar]:hidden"
			>
				{tabs.map((tab) => (
					<TabsTrigger
						key={tab.href}
						value={tab.href}
						nativeButton={false}
						aria-current={tab.href === current ? "page" : undefined}
						render={<Link href={tab.href} />}
						className="h-10 flex-none gap-2 focus-visible:-outline-offset-2 group-data-[variant=line]/tabs-list:rounded-none group-data-[variant=line]/tabs-list:px-0 group-data-horizontal/tabs:after:bottom-0"
					>
						{tab.icon ? <tab.icon className="size-4" /> : null}
						{tab.title}
						{tab.dot ? (
							<span
								role="img"
								aria-label={tab.dot}
								className="size-1.5 shrink-0 rounded-full bg-warning"
							/>
						) : null}
					</TabsTrigger>
				))}
			</TabsList>
		</Tabs>
	);
}
