"use client";

import { Select as SelectPrimitive } from "@base-ui/react/select";
import { cn } from "cn";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import * as React from "react";
import { OptionIcon } from "@/components/ui/option-icon";
import { plainLabel } from "@/lib/action-icons";
import {
	nameMark,
	type OptionNames,
	optionMark,
	optionMarks,
} from "@/lib/option-icons";

type SelectItemLabel = { value: unknown; label: React.ReactNode };
/* `text` is the label when it is only text; an item with a mark of its own
   (or `autoIcon={false}`) has none. `name` is the text an item starts with,
   whatever follows it (an address, a count). */
type ListedItem = SelectItemLabel & {
	text: string | undefined;
	name: string | undefined;
};

/* Whether this select's options carry the mark of their label, and what
   they name when they are names. A list is marked whole or not at all (see
   `optionMarks`), which only the root can tell. */
const MarkedOptions = React.createContext<{
	marked: boolean;
	names?: OptionNames;
}>({ marked: false });

/* The text a label starts with: "web-1" of `web-1 <span>10.0.0.5</span>`. */
function leadingText(children: React.ReactNode): string | undefined {
	for (const child of React.Children.toArray(children)) {
		if (typeof child === "string" || typeof child === "number") {
			const text = String(child).trim();
			if (text) return text;
		} else if (
			React.isValidElement<{ children?: React.ReactNode }>(child) &&
			child.props.children !== undefined
		) {
			const text = leadingText(child.props.children);
			if (text) return text;
		}
	}
	return undefined;
}

/* Panara Cloud: Base UI's <Select.Value> shows the raw value unless the root
   gets `items`. Our screens list their <SelectItem>s inline (Radix read the
   label from the selected item), so when no `items` are passed they are read
   from the JSX children. Items rendered inside another component can't be
   seen here; pass `items` explicitly for those. */
function collectItems(node: React.ReactNode, out: ListedItem[]) {
	React.Children.forEach(node, (child) => {
		if (
			!React.isValidElement<{
				value?: unknown;
				children?: React.ReactNode;
				autoIcon?: boolean;
			}>(child)
		)
			return;
		if (child.type === SelectItem) {
			out.push({
				value: child.props.value,
				label: child.props.children,
				text:
					child.props.autoIcon === false
						? undefined
						: (plainLabel(child.props.children) ?? undefined),
				name:
					child.props.autoIcon === false
						? undefined
						: leadingText(child.props.children),
			});
			return;
		}
		if (child.props.children !== undefined)
			collectItems(child.props.children, out);
	});
}

type SelectProps<Value, Multiple extends boolean | undefined = false> = Omit<
	SelectPrimitive.Root.Props<Value, Multiple>,
	"onValueChange"
> & {
	/* Radix never reported `null`; nothing here renders a null item either. */
	onValueChange?: (
		value: Multiple extends true ? Value[] : Value,
		eventDetails: SelectPrimitive.Root.ChangeEventDetails,
	) => void;
	/** Options that are only text get the mark of their label ("Last
	    activity", "PostgreSQL", "Failed"), in the list and in the trigger;
	    false for a list whose labels are data. */
	autoIcon?: boolean;
	/** What the options name when they are names (servers, projects,
	    registries): each then gets the mark of its kind, and the options
	    beside them ("All", "None", the Panara Cloud host) keep their own. */
	names?: OptionNames;
};

function Select<Value = string, Multiple extends boolean | undefined = false>({
	items,
	children,
	onValueChange,
	autoIcon = true,
	names,
	...props
}: SelectProps<Value, Multiple>) {
	const { derived, marked } = React.useMemo(() => {
		const listed: ListedItem[] = [];
		collectItems(children, listed);
		const marks = autoIcon
			? optionMarks(
					listed.map((item) => (names ? item.name : item.text)),
					names,
				)
			: null;
		if (items) return { derived: items, marked: marks !== null };
		const labels: SelectItemLabel[] = listed.map(({ value, label }, index) => {
			const mark = marks?.[index];
			return mark
				? {
						value,
						label: (
							<>
								<OptionIcon mark={mark} />
								{label}
							</>
						),
					}
				: { value, label };
		});
		return {
			derived: labels.length ? labels : undefined,
			marked: marks !== null,
		};
	}, [items, children, autoIcon, names]);
	const context = React.useMemo(() => ({ marked, names }), [marked, names]);
	// Panara Cloud: forms pass `value={field.value}`, which is undefined until
	// the form loads; keep the select controlled (null = nothing selected)
	// instead of switching from uncontrolled to controlled.
	const rootProps =
		"value" in props && props.value === undefined
			? { ...props, value: null }
			: props;
	return (
		<MarkedOptions value={context}>
			<SelectPrimitive.Root<Value, Multiple>
				items={derived}
				onValueChange={
					onValueChange &&
					((value, details) => {
						if (value === null) return;
						onValueChange(
							value as Multiple extends true ? Value[] : Value,
							details,
						);
					})
				}
				{...(rootProps as typeof props)}
			>
				{children}
			</SelectPrimitive.Root>
		</MarkedOptions>
	);
}

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
	return (
		<SelectPrimitive.Group
			data-slot="select-group"
			className={cn("flex scroll-my-1 flex-col gap-1", className)}
			{...props}
		/>
	);
}

function SelectValue({
	className,
	children,
	...props
}: SelectPrimitive.Value.Props) {
	const { marked, names } = React.use(MarkedOptions);
	// A trigger that words the value itself ("TCP" for `tcp`) keeps its mark.
	const mark =
		marked && typeof children === "string"
			? names
				? nameMark(names, children)
				: optionMark(children)
			: null;
	return (
		<SelectPrimitive.Value
			data-slot="select-value"
			className={cn("flex flex-1 items-center gap-1.5 text-left", className)}
			{...props}
		>
			{mark ? (
				<>
					<OptionIcon mark={mark} />
					{children}
				</>
			) : (
				children
			)}
		</SelectPrimitive.Value>
	);
}

export const selectTriggerClassName =
	"flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-field py-2 pr-2.5 pl-3 text-sm whitespace-nowrap shadow-none transition-[border-color,box-shadow] outline-none select-none hover:border-border-strong focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 data-placeholder:text-faint-foreground data-[size=default]:h-control data-[size=sm]:h-control-sm *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

function SelectTrigger({
	className,
	size = "default",
	children,
	...props
}: SelectPrimitive.Trigger.Props & {
	size?: "sm" | "default";
}) {
	return (
		<SelectPrimitive.Trigger
			data-slot="select-trigger"
			data-size={size}
			className={cn(selectTriggerClassName, className)}
			{...props}
		>
			{children}
			<SelectPrimitive.Icon
				render={
					<ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
				}
			/>
		</SelectPrimitive.Trigger>
	);
}

function SelectContent({
	className,
	children,
	side = "bottom",
	sideOffset = 4,
	align = "start",
	alignOffset = 0,
	// The list opens under the field, never over it.
	alignItemWithTrigger = false,
	...props
}: SelectPrimitive.Popup.Props &
	Pick<
		SelectPrimitive.Positioner.Props,
		"align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"
	>) {
	return (
		<SelectPrimitive.Portal>
			<SelectPrimitive.Positioner
				side={side}
				sideOffset={sideOffset}
				align={align}
				alignOffset={alignOffset}
				alignItemWithTrigger={alignItemWithTrigger}
				className="isolate z-50"
			>
				<SelectPrimitive.Popup
					data-slot="select-content"
					data-align-trigger={alignItemWithTrigger}
					className={cn(
						"relative isolate z-50 max-h-(--available-height) w-max max-w-(--available-width) min-w-[max(9rem,var(--anchor-width))] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-xl border border-border bg-popover text-popover-foreground shadow-float duration-100 data-[align-trigger=true]:animate-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
						className,
					)}
					{...props}
				>
					<SelectScrollUpButton />
					<SelectPrimitive.List className="p-1.5">
						{children}
					</SelectPrimitive.List>
					<SelectScrollDownButton />
				</SelectPrimitive.Popup>
			</SelectPrimitive.Positioner>
		</SelectPrimitive.Portal>
	);
}

function SelectLabel({
	className,
	...props
}: SelectPrimitive.GroupLabel.Props) {
	return (
		<SelectPrimitive.GroupLabel
			data-slot="select-label"
			className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)}
			{...props}
		/>
	);
}

function SelectItem({
	className,
	children,
	autoIcon = true,
	...props
}: SelectPrimitive.Item.Props & {
	/** False for a label that is data, so it never gets a mark. */
	autoIcon?: boolean;
}) {
	const { marked, names } = React.use(MarkedOptions);
	const label =
		marked && autoIcon
			? names
				? leadingText(children)
				: plainLabel(children)
			: null;
	const mark = label
		? names
			? nameMark(names, label)
			: optionMark(label)
		: null;
	return (
		<SelectPrimitive.Item
			data-slot="select-item"
			className={cn(
				"relative flex w-full cursor-default items-center gap-2 rounded-lg py-1.5 pr-8 pl-2 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
				className,
			)}
			{...props}
		>
			<SelectPrimitive.ItemText className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap">
				{mark ? <OptionIcon mark={mark} /> : null}
				{children}
			</SelectPrimitive.ItemText>
			<SelectPrimitive.ItemIndicator
				render={
					<span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
				}
			>
				<CheckIcon className="pointer-events-none" />
			</SelectPrimitive.ItemIndicator>
		</SelectPrimitive.Item>
	);
}

function SelectSeparator({
	className,
	...props
}: SelectPrimitive.Separator.Props) {
	return (
		<SelectPrimitive.Separator
			data-slot="select-separator"
			className={cn(
				"pointer-events-none -mx-1.5 my-1.5 h-px bg-border",
				className,
			)}
			{...props}
		/>
	);
}

function SelectScrollUpButton({
	className,
	...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
	return (
		<SelectPrimitive.ScrollUpArrow
			data-slot="select-scroll-up-button"
			className={cn(
				"top-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
				className,
			)}
			{...props}
		>
			<ChevronUpIcon />
		</SelectPrimitive.ScrollUpArrow>
	);
}

function SelectScrollDownButton({
	className,
	...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
	return (
		<SelectPrimitive.ScrollDownArrow
			data-slot="select-scroll-down-button"
			className={cn(
				"bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
				className,
			)}
			{...props}
		>
			<ChevronDownIcon />
		</SelectPrimitive.ScrollDownArrow>
	);
}

export {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectScrollDownButton,
	SelectScrollUpButton,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
};
