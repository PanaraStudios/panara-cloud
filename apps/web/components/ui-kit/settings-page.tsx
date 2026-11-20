"use client";

import type { ComponentType } from "react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// A Settings page that is every section on one page (a service's, a
// server's): `SettingsSections` stacks `SettingsSection`s split by a
// hairline, `SectionLinks` is the optional row of jump links above them.

/** Renders its children once they come near the viewport, so a long page
    doesn't start every section's queries at once. Once shown they stay, so
    unsaved edits survive scrolling. */
export function LazyMount({
	now = false,
	children,
}: {
	/** Mount without waiting (the section the URL points at). */
	now?: boolean;
	children: React.ReactNode;
}) {
	const placeholder = useRef<HTMLDivElement>(null);
	const [near, setNear] = useState(false);
	const mounted = near || now;
	useEffect(() => {
		const element = placeholder.current;
		if (mounted || !element) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) setNear(true);
			},
			{ rootMargin: "400px 0px" },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [mounted]);
	if (now && !near) setNear(true);
	if (mounted) return children;
	return (
		<div ref={placeholder} aria-hidden className="flex flex-col gap-3">
			<Skeleton className="h-9 w-full max-w-3xl" />
			<Skeleton className="h-9 w-full max-w-3xl" />
		</div>
	);
}

/** Scrolls to a section and keeps it at the top of the window while the
    ones above it finish mounting, until the member scrolls. Returns the ref
    for the page's container and the function that jumps. */
export function useSectionJump() {
	const page = useRef<HTMLDivElement>(null);
	const [pin, setPin] = useState<{ id: string } | null>(null);
	useLayoutEffect(() => {
		const container = page.current;
		const element = pin ? document.getElementById(pin.id) : null;
		if (!container || !element) return;
		const align = () => element.scrollIntoView({ block: "start" });
		align();
		const observer = new ResizeObserver(align);
		observer.observe(container);
		const events = ["wheel", "touchstart", "keydown", "mousedown"] as const;
		const stop = () => {
			observer.disconnect();
			window.clearTimeout(timer);
			for (const event of events) window.removeEventListener(event, stop);
		};
		const timer = window.setTimeout(stop, 2500);
		for (const event of events) {
			window.addEventListener(event, stop, { passive: true });
		}
		return stop;
	}, [pin]);
	const jumpTo = useCallback((id: string) => setPin({ id }), []);
	return [page, jumpTo] as const;
}

export function SettingsSections({
	ref,
	links,
	children,
}: {
	ref?: React.Ref<HTMLDivElement>;
	/** A `SectionLinks` row above the sections. */
	links?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<div ref={ref} className="flex w-full min-w-0 flex-col gap-8 pb-16">
			{links}
			<div className="flex min-w-0 flex-col">{children}</div>
		</div>
	);
}

/** One row of small links to the sections of the page. A plain click jumps
    in place and moves the URL without a navigation (which would remount the
    page and drop unsaved edits). */
export function SectionLinks({
	label,
	links,
	onJump,
}: {
	label: string;
	links: readonly {
		id: string;
		title: string;
		href: string;
		/** What a dot after the link stands for ("Changes not deployed"). */
		dot?: string;
	}[];
	onJump: (id: string) => void;
}) {
	return (
		<nav
			aria-label={label}
			className="flex flex-wrap gap-x-4 gap-y-1.5 text-[13px]"
		>
			{links.map((link) => (
				<a
					key={link.id}
					href={link.href}
					className="inline-flex items-center gap-1.5 rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
					onClick={(event) => {
						if (event.metaKey || event.ctrlKey || event.shiftKey) return;
						event.preventDefault();
						window.history.replaceState(null, "", link.href);
						onJump(link.id);
					}}
				>
					{link.title}
					{link.dot ? (
						<span
							role="img"
							aria-label={link.dot}
							className="size-1.5 shrink-0 rounded-full bg-warning"
						/>
					) : null}
				</a>
			))}
		</nav>
	);
}

/** One section of the page: icon and title, one line, an optional notice,
    then its body, mounted when it nears the viewport. `collapsible` sections
    are one row ("Show") until opened, and mount nothing before that. */
export function SettingsSection({
	id,
	icon: Icon,
	title,
	description,
	notice,
	collapsible = false,
	open = true,
	onOpenChange,
	target = false,
	className,
	children,
}: {
	id: string;
	icon: ComponentType<{ className?: string }>;
	title: string;
	description?: React.ReactNode;
	/** Shown under the description while the section is open. */
	notice?: React.ReactNode;
	collapsible?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	/** The URL points at this section: mount it at once. */
	target?: boolean;
	/** For the body: `max-w-3xl` for a form. */
	className?: string;
	children: React.ReactNode;
}) {
	const expanded = !collapsible || open;
	return (
		<section
			id={id}
			aria-labelledby={`${id}-title`}
			className={cn(
				"flex min-w-0 scroll-mt-6 flex-col gap-5 border-border border-t first:border-t-0",
				expanded ? "py-8 first:pt-0" : "py-4",
			)}
		>
			<div
				className={cn(
					"flex min-w-0 gap-x-4",
					expanded ? "items-start" : "items-center",
				)}
			>
				<div
					className={cn(
						"flex min-w-0 flex-1",
						expanded
							? "flex-col gap-1"
							: "items-center gap-x-3 gap-y-0.5 max-sm:flex-col max-sm:items-start",
					)}
				>
					<h2
						id={`${id}-title`}
						className="flex shrink-0 items-center gap-2 font-semibold text-[15px] leading-snug"
					>
						<Icon
							aria-hidden
							className="size-4 shrink-0 text-muted-foreground"
						/>
						{title}
					</h2>
					{description ? (
						<p
							className={cn(
								"min-w-0 text-muted-foreground text-sm",
								!expanded && "truncate max-sm:whitespace-normal",
							)}
						>
							{description}
						</p>
					) : null}
					{expanded ? notice : null}
				</div>
				{collapsible ? (
					<Button
						variant="outline"
						size="sm"
						className="shrink-0"
						aria-expanded={expanded}
						aria-controls={`${id}-body`}
						onClick={() => onOpenChange?.(!expanded)}
					>
						{expanded ? "Hide" : "Show"}
					</Button>
				) : null}
			</div>
			{expanded ? (
				<div id={`${id}-body`} className={cn("min-w-0", className)}>
					<LazyMount now={target}>{children}</LazyMount>
				</div>
			) : null}
		</section>
	);
}
