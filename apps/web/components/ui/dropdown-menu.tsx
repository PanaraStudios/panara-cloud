"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "cn";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import * as React from "react";
import { OptionIcon } from "@/components/ui/option-icon";
import { actionIcon, plainLabel } from "@/lib/action-icons";
import {
	nameMark,
	type OptionNames,
	optionMark,
	optionMarks,
} from "@/lib/option-icons";

/* Whether the checkbox and radio items of this menu, or of this group of it,
   carry the mark of their label, and what they name when they are names: a
   list is marked whole or not at all (see `optionMarks`), which only what
   holds the items can tell. */
const MarkedChoices = React.createContext<{
	marked: boolean;
	names?: OptionNames;
}>({ marked: false });

/* The choices directly in a menu or a group; a group inside is a list of
   its own ("Since" and "Lines kept" in one menu). */
function choiceLabels(node: React.ReactNode, out: (string | undefined)[]) {
	React.Children.forEach(node, (child) => {
		if (
			!React.isValidElement<{ children?: React.ReactNode; autoIcon?: boolean }>(
				child,
			)
		)
			return;
		if (
			child.type === DropdownMenuCheckboxItem ||
			child.type === DropdownMenuRadioItem
		) {
			out.push(
				child.props.autoIcon === false
					? undefined
					: (plainLabel(child.props.children) ?? undefined),
			);
			return;
		}
		if (
			child.type === DropdownMenuGroup ||
			child.type === DropdownMenuRadioGroup ||
			child.type === DropdownMenuSub
		)
			return;
		choiceLabels(child.props.children, out);
	});
}

function MarkedChoiceList({
	names,
	children,
}: {
	names?: OptionNames;
	children: React.ReactNode;
}) {
	const labels: (string | undefined)[] = [];
	choiceLabels(children, labels);
	const marked = optionMarks(labels, names) !== null;
	const value = React.useMemo(() => ({ marked, names }), [marked, names]);
	return <MarkedChoices value={value}>{children}</MarkedChoices>;
}

function useChoiceMark(children: React.ReactNode, autoIcon: boolean) {
	const { marked, names } = React.use(MarkedChoices);
	const plain = marked && autoIcon ? plainLabel(children) : null;
	if (!plain) return null;
	return names ? nameMark(names, plain) : optionMark(plain);
}

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
	return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
	return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
	return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
	align = "start",
	alignOffset = 0,
	side = "bottom",
	sideOffset = 4,
	className,
	children,
	...props
}: MenuPrimitive.Popup.Props &
	Pick<
		MenuPrimitive.Positioner.Props,
		"align" | "alignOffset" | "side" | "sideOffset"
	>) {
	return (
		<MenuPrimitive.Portal>
			<MenuPrimitive.Positioner
				className="isolate z-50 outline-none"
				align={align}
				alignOffset={alignOffset}
				side={side}
				sideOffset={sideOffset}
			>
				<MenuPrimitive.Popup
					data-slot="dropdown-menu-content"
					className={cn(
						"z-50 flex max-h-(--available-height) w-max max-w-(--available-width) min-w-[max(8rem,var(--anchor-width))] origin-(--transform-origin) flex-col gap-1 overflow-x-hidden overflow-y-auto rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-float duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95",
						className,
					)}
					{...props}
				>
					<MarkedChoiceList>{children}</MarkedChoiceList>
				</MenuPrimitive.Popup>
			</MenuPrimitive.Positioner>
		</MenuPrimitive.Portal>
	);
}

function DropdownMenuGroup({
	className,
	children,
	...props
}: MenuPrimitive.Group.Props) {
	return (
		<MenuPrimitive.Group
			data-slot="dropdown-menu-group"
			className={cn("flex flex-col gap-1", className)}
			{...props}
		>
			<MarkedChoiceList>{children}</MarkedChoiceList>
		</MenuPrimitive.Group>
	);
}

function DropdownMenuLabel({
	className,
	inset,
	...props
}: MenuPrimitive.GroupLabel.Props & {
	inset?: boolean;
}) {
	return (
		<MenuPrimitive.GroupLabel
			data-slot="dropdown-menu-label"
			data-inset={inset}
			className={cn(
				"px-2 py-1.5 text-xs font-medium text-muted-foreground data-inset:pl-8",
				className,
			)}
			{...props}
		/>
	);
}

function DropdownMenuItem({
	className,
	inset,
	variant = "default",
	autoIcon = true,
	disabled,
	disabledReason,
	children,
	...props
}: MenuPrimitive.Item.Props & {
	inset?: boolean;
	variant?: "default" | "destructive";
	/** A text-only label gets the icon of its action; false for a label that
	    is data (a server's name), not an action. */
	autoIcon?: boolean;
	/** Why the action can't run right now, in a few words ("Deploying…"):
	    disables the item and shows the reason at its end. */
	disabledReason?: string | null;
}) {
	const plain = autoIcon && !inset ? plainLabel(children) : null;
	const ActionIcon = plain ? actionIcon(plain) : null;
	const blocked = Boolean(disabledReason);
	return (
		<MenuPrimitive.Item
			data-slot="dropdown-menu-item"
			data-inset={inset}
			data-variant={variant}
			data-blocked={blocked || undefined}
			disabled={disabled || blocked}
			className={cn(
				"group/dropdown-menu-item relative flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-8 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive",
				// The label dims, the reason stays readable.
				"data-blocked:opacity-100 data-blocked:text-foreground/45 data-blocked:*:opacity-45 data-blocked:data-[variant=destructive]:text-destructive/45 data-blocked:*:data-[slot=dropdown-menu-item-reason]:opacity-100",
				className,
			)}
			{...props}
		>
			{ActionIcon ? <ActionIcon aria-hidden /> : null}
			{children}
			{blocked ? (
				<span
					data-slot="dropdown-menu-item-reason"
					className="ml-auto pl-4 text-muted-foreground text-xs"
				>
					{disabledReason}
				</span>
			) : null}
		</MenuPrimitive.Item>
	);
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
	return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
	className,
	inset,
	children,
	...props
}: MenuPrimitive.SubmenuTrigger.Props & {
	inset?: boolean;
}) {
	return (
		<MenuPrimitive.SubmenuTrigger
			data-slot="dropdown-menu-sub-trigger"
			data-inset={inset}
			className={cn(
				"flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-8 data-popup-open:bg-accent data-popup-open:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				className,
			)}
			{...props}
		>
			{children}
			<ChevronRightIcon className="ml-auto" />
		</MenuPrimitive.SubmenuTrigger>
	);
}

function DropdownMenuSubContent({
	align = "start",
	alignOffset = -3,
	side = "right",
	sideOffset = 0,
	className,
	...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
	return (
		<DropdownMenuContent
			data-slot="dropdown-menu-sub-content"
			className={cn(
				"flex w-auto min-w-[96px] flex-col gap-1 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lifted duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
				className,
			)}
			align={align}
			alignOffset={alignOffset}
			side={side}
			sideOffset={sideOffset}
			{...props}
		/>
	);
}

function DropdownMenuCheckboxItem({
	className,
	children,
	checked,
	inset,
	autoIcon = true,
	...props
}: MenuPrimitive.CheckboxItem.Props & {
	inset?: boolean;
	/** A text-only label gets the mark of what it names ("Failed",
	    "Timestamps"); false for a label that is data. */
	autoIcon?: boolean;
}) {
	const mark = useChoiceMark(children, autoIcon && !inset);
	return (
		<MenuPrimitive.CheckboxItem
			data-slot="dropdown-menu-checkbox-item"
			data-inset={inset}
			className={cn(
				"relative flex cursor-default items-center gap-2 rounded-lg py-1.5 pr-8 pl-2 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-8 data-disabled:pointer-events-none data-disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				className,
			)}
			checked={checked}
			{...props}
		>
			<span
				className="pointer-events-none absolute right-2 flex items-center justify-center"
				data-slot="dropdown-menu-checkbox-item-indicator"
			>
				<MenuPrimitive.CheckboxItemIndicator>
					<CheckIcon />
				</MenuPrimitive.CheckboxItemIndicator>
			</span>
			{mark ? <OptionIcon mark={mark} /> : null}
			{children}
		</MenuPrimitive.CheckboxItem>
	);
}

function DropdownMenuRadioGroup({
	names,
	children,
	...props
}: MenuPrimitive.RadioGroup.Props & {
	/** What the choices name when they are names or amounts ("1,000" lines):
	    each then gets the mark of its kind. */
	names?: OptionNames;
}) {
	return (
		<MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props}>
			<MarkedChoiceList names={names}>{children}</MarkedChoiceList>
		</MenuPrimitive.RadioGroup>
	);
}

function DropdownMenuRadioItem({
	className,
	children,
	inset,
	autoIcon = true,
	...props
}: MenuPrimitive.RadioItem.Props & {
	inset?: boolean;
	/** A text-only label gets the mark of what it names ("Live", "Last
	    hour"); false for a label that is data. */
	autoIcon?: boolean;
}) {
	const mark = useChoiceMark(children, autoIcon && !inset);
	return (
		<MenuPrimitive.RadioItem
			data-slot="dropdown-menu-radio-item"
			data-inset={inset}
			className={cn(
				"relative flex cursor-default items-center gap-2 rounded-lg py-1.5 pr-8 pl-2 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-8 data-disabled:pointer-events-none data-disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
				className,
			)}
			{...props}
		>
			<span
				className="pointer-events-none absolute right-2 flex items-center justify-center"
				data-slot="dropdown-menu-radio-item-indicator"
			>
				<MenuPrimitive.RadioItemIndicator>
					<CheckIcon />
				</MenuPrimitive.RadioItemIndicator>
			</span>
			{mark ? <OptionIcon mark={mark} /> : null}
			{children}
		</MenuPrimitive.RadioItem>
	);
}

function DropdownMenuSeparator({
	className,
	...props
}: MenuPrimitive.Separator.Props) {
	return (
		<MenuPrimitive.Separator
			data-slot="dropdown-menu-separator"
			className={cn("-mx-1.5 my-1.5 h-px bg-border", className)}
			{...props}
		/>
	);
}

function DropdownMenuShortcut({
	className,
	...props
}: React.ComponentProps<"span">) {
	return (
		<span
			data-slot="dropdown-menu-shortcut"
			className={cn(
				"ml-auto text-xs tracking-widest text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground",
				className,
			)}
			{...props}
		/>
	);
}

export {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuPortal,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
};
