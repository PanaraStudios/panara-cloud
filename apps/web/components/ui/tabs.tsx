"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import * as React from "react";
import { OptionIcon } from "@/components/ui/option-icon";
import { plainLabel } from "@/lib/action-icons";
import { optionMark, optionMarks } from "@/lib/option-icons";

/* Whether this list's tabs carry the mark of their label: a list is marked
   whole or not at all (see `optionMarks`), which only the list can tell. */
const MarkedTabs = React.createContext(false);

function tabLabels(node: React.ReactNode, out: (string | undefined)[]) {
	React.Children.forEach(node, (child) => {
		if (
			!React.isValidElement<{ children?: React.ReactNode; autoIcon?: boolean }>(
				child,
			)
		)
			return;
		if (child.type === TabsTrigger) {
			out.push(
				child.props.autoIcon === false
					? undefined
					: (plainLabel(child.props.children) ?? undefined),
			);
			return;
		}
		tabLabels(child.props.children, out);
	});
}

/* `default` is reechlist's segmented toggle: a white pill track with a hairline border, the
   active tab sits on the page color with a hairline shadow. `line` keeps the accent underline.
   In a horizontal list the pill and the underline are one indicator that slides to the
   active tab; a vertical list marks the tab itself. */
function Tabs({
	className,
	orientation = "horizontal",
	...props
}: TabsPrimitive.Root.Props) {
	return (
		<TabsPrimitive.Root
			data-slot="tabs"
			data-orientation={orientation}
			className={cn(
				"group/tabs flex min-w-0 gap-2 data-horizontal:flex-col",
				className,
			)}
			{...props}
		/>
	);
}

const tabsListVariants = cva(
	"group/tabs-list relative isolate inline-flex w-fit items-center justify-start text-muted-foreground group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col",
	{
		variants: {
			variant: {
				default:
					"h-9 gap-1 rounded-full border border-border bg-muted p-[3px] group-data-vertical/tabs:h-fit group-data-vertical/tabs:rounded-xl",
				line: "gap-1 rounded-none bg-transparent",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

const FADE = "1.25rem";

/* A pill list wider than its place scrolls inside itself, fading at the edge
   that hides more, so it never widens the page. */
function useEdgeFade(enabled: boolean) {
	const ref = React.useRef<HTMLDivElement>(null);
	const [hidden, setHidden] = React.useState({ start: false, end: false });
	React.useEffect(() => {
		const list = ref.current;
		if (!list || !enabled) return;
		const measure = () => {
			const start = list.scrollLeft > 1;
			const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
			setHidden((previous) =>
				previous.start === start && previous.end === end
					? previous
					: { start, end },
			);
		};
		const active = list.querySelector<HTMLElement>("[data-active]");
		if (active && list.scrollWidth > list.clientWidth) {
			list.scrollLeft =
				active.offsetLeft - (list.clientWidth - active.offsetWidth) / 2;
		}
		measure();
		list.addEventListener("scroll", measure, { passive: true });
		const observer = new ResizeObserver(measure);
		observer.observe(list);
		return () => {
			list.removeEventListener("scroll", measure);
			observer.disconnect();
		};
	}, [enabled]);
	const mask =
		hidden.start || hidden.end
			? `linear-gradient(to right, ${hidden.start ? "transparent" : "black"}, black ${FADE}, black calc(100% - ${FADE}), ${hidden.end ? "transparent" : "black"})`
			: undefined;
	return { ref, mask };
}

function TabsList({
	className,
	variant = "default",
	children,
	ref,
	style,
	onClick,
	...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
	const labels: (string | undefined)[] = [];
	tabLabels(children, labels);
	const pills = variant === "default";
	const fade = useEdgeFade(pills);
	return (
		<TabsPrimitive.List
			ref={(node) => {
				fade.ref.current = node;
				if (typeof ref === "function") return ref(node);
				if (ref) ref.current = node;
			}}
			data-slot="tabs-list"
			data-variant={variant}
			className={cn(
				tabsListVariants({ variant }),
				pills &&
					"max-w-full group-data-horizontal/tabs:overflow-x-auto group-data-horizontal/tabs:[scrollbar-width:none] group-data-horizontal/tabs:[&::-webkit-scrollbar]:hidden",
				className,
			)}
			style={
				fade.mask
					? { maskImage: fade.mask, WebkitMaskImage: fade.mask, ...style }
					: style
			}
			onClick={(event) => {
				onClick?.(event);
				if (!pills || !(event.target instanceof Element)) return;
				event.target
					.closest("[role=tab]")
					?.scrollIntoView({ block: "nearest", inline: "nearest" });
			}}
			{...props}
		>
			<MarkedTabs value={optionMarks(labels) !== null}>{children}</MarkedTabs>
			<TabsPrimitive.Indicator
				data-slot="tabs-indicator"
				className={cn(
					"pointer-events-none absolute left-0 w-(--active-tab-width) translate-x-(--active-tab-left) transition-[translate,width] duration-200 ease-(--ease-out) group-data-vertical/tabs:hidden motion-reduce:transition-none",
					variant === "line"
						? "bottom-0 h-0.5 bg-primary"
						: "top-(--active-tab-top) -z-10 h-(--active-tab-height) rounded-full border border-border bg-surface shadow-xs dark:bg-background",
				)}
			/>
		</TabsPrimitive.List>
	);
}

function TabsTrigger({
	className,
	children,
	autoIcon = true,
	...props
}: TabsPrimitive.Tab.Props & {
	/** A text-only label gets the mark of what it names ("Worker",
	    "Logs"); false for a label that is data. */
	autoIcon?: boolean;
}) {
	const marked = React.use(MarkedTabs);
	const plain = marked && autoIcon ? plainLabel(children) : null;
	const mark = plain ? optionMark(plain) : null;
	return (
		<TabsPrimitive.Tab
			data-slot="tabs-trigger"
			className={cn(
				"relative inline-flex h-full min-h-7 flex-1 shrink-0 items-center justify-center gap-1.5 rounded-full border border-transparent px-3.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-45 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5 aria-disabled:pointer-events-none aria-disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
				"group-data-[variant=default]/tabs-list:data-active:text-foreground group-data-vertical/tabs:group-data-[variant=default]/tabs-list:data-active:border-border group-data-vertical/tabs:group-data-[variant=default]/tabs-list:data-active:bg-surface group-data-vertical/tabs:group-data-[variant=default]/tabs-list:data-active:shadow-xs dark:group-data-vertical/tabs:group-data-[variant=default]/tabs-list:data-active:bg-background",
				"group-data-[variant=line]/tabs-list:rounded-md group-data-[variant=line]/tabs-list:px-2 group-data-[variant=line]/tabs-list:text-sm group-data-[variant=line]/tabs-list:font-medium group-data-[variant=line]/tabs-list:data-active:text-foreground",
				"after:absolute after:bg-primary after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-vertical/tabs:group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
				mark && !("tone" in mark) && "pl-2.5",
				className,
			)}
			{...props}
		>
			{mark ? <OptionIcon compact mark={mark} /> : null}
			{children}
		</TabsPrimitive.Tab>
	);
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
	return (
		<TabsPrimitive.Panel
			data-slot="tabs-content"
			className={cn("flex-1 text-sm outline-none", className)}
			{...props}
		/>
	);
}

export { Tabs, TabsContent, TabsList, TabsTrigger, tabsListVariants };
