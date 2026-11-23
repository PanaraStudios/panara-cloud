"use client";

import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/** The row above a section's table: a count or a filter on the left, the
    section's actions on the right. */
export function SectionToolbar({
	children,
	actions,
}: {
	children?: React.ReactNode;
	actions?: React.ReactNode;
}) {
	return (
		<div className="flex min-h-8 flex-col gap-2 sm:flex-row sm:items-center">
			<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-muted-foreground text-sm">
				{children}
			</div>
			{actions ? (
				<div className="flex shrink-0 flex-wrap items-center gap-2">
					{actions}
				</div>
			) : null}
		</div>
	);
}

/** "3 ports", "1 port". */
export function countLabel(count: number, noun: string, plural = `${noun}s`) {
	return `${count} ${count === 1 ? noun : plural}`;
}

/** Title row of a settings sub-page (`settings/domains/new`): a way back to
    the list, then what the page does. */
export function SubPageHeader({
	back,
	list,
	title,
}: {
	back: string;
	/** The list the page belongs to ("Domains"). */
	list: string;
	title: string;
}) {
	return (
		<div className="flex min-w-0 items-center gap-1.5">
			<Button
				variant="ghost"
				size="icon-sm"
				nativeButton={false}
				className="-ml-1.5 shrink-0"
				aria-label={`Back to ${list}`}
				render={<Link href={back} />}
			>
				<ArrowLeftIcon />
			</Button>
			<h2 className="min-w-0 truncate font-semibold text-[15px]">{title}</h2>
		</div>
	);
}

/** A setting that is one switch: its name and one line, the switch on the
    right. Rows stack with a hairline between them. */
export function SwitchRow({
	id,
	title,
	description,
	checked,
	disabled,
	onCheckedChange,
	className,
}: {
	id?: string;
	title: string;
	description?: React.ReactNode;
	checked: boolean;
	disabled?: boolean;
	onCheckedChange: (checked: boolean) => void;
	className?: string;
}) {
	return (
		<div
			className={cn("flex items-center justify-between gap-6 py-3", className)}
		>
			<div className="flex min-w-0 flex-col gap-0.5">
				{id ? (
					<label htmlFor={id} className="font-medium text-sm">
						{title}
					</label>
				) : (
					<span className="font-medium text-sm">{title}</span>
				)}
				{description ? (
					<span className="text-muted-foreground text-sm">{description}</span>
				) : null}
			</div>
			<Switch
				id={id}
				aria-label={id ? undefined : title}
				checked={checked}
				disabled={disabled}
				onCheckedChange={onCheckedChange}
			/>
		</div>
	);
}

/** "Changed", "Added", "Unsaved": a row's state since the last deploy. */
export function ChangeTag({
	label = "Changed",
	className,
}: {
	label?: string;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-6 items-center rounded-md bg-warning/10 px-2 font-medium text-warning text-xs",
				className,
			)}
		>
			{label}
		</span>
	);
}

/** A code editor inside a frame that already draws the hairline: the editor
    drops its own border, radius and fill. */
export const FRAMED_EDITOR =
	"[&_.cm-editor]:rounded-none [&_.cm-editor]:border-0 [&_.cm-editor]:bg-transparent! [&_.cm-gutters]:bg-transparent!";

/** Tint of a row with unsaved or undeployed edits. */
export const DRAFT_ROW = "bg-warning/[0.04] hover:bg-warning/[0.06]";

/** One quiet line under a table; `tone="error"` for what went wrong. */
export function Note({
	children,
	tone,
	className,
}: {
	children: React.ReactNode;
	tone?: "error";
	className?: string;
}) {
	return (
		<p
			role={tone === "error" ? "alert" : undefined}
			className={cn(
				"text-sm",
				tone === "error" ? "text-destructive" : "text-muted-foreground",
				className,
			)}
		>
			{children}
		</p>
	);
}

/** The ⌘S hint inside an ink Save button. */
export function SaveKey() {
	return (
		<kbd className="ml-0.5 rounded bg-primary-foreground/15 px-1 font-sans text-[11px] max-sm:hidden">
			⌘S
		</kbd>
	);
}

/** The shell of a bar that floats over the page bottom, centred in the
    content column, while edits are not saved. */
export function FloatingBar({ children }: { children: React.ReactNode }) {
	return (
		<div className="pointer-events-none fixed inset-x-0 bottom-6 z-30 flex justify-center px-4 md:pl-[calc(var(--sidebar-width,0px)+1rem)]">
			<div className="pointer-events-auto flex max-w-full items-center gap-4 rounded-xl border border-border bg-background py-1.5 pr-1.5 pl-4 shadow-lg">
				{children}
			</div>
		</div>
	);
}

/** Floating bar for inline edits that are not saved yet ("1 unsaved change ·
    applies with a reload  Discard  Save ⌘S"). ⌘S / Ctrl+S saves. */
export function UnsavedBar({
	count,
	hint,
	onDiscard,
	onSave,
	saving,
	disabled,
}: {
	count: number;
	hint: string;
	onDiscard: () => void;
	onSave: () => void;
	saving?: boolean;
	disabled?: boolean;
}) {
	useEffect(() => {
		if (count === 0) return;
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key === "s") {
				event.preventDefault();
				if (!disabled && !saving) onSave();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [count, disabled, saving, onSave]);

	if (count === 0) return null;
	return (
		<FloatingBar>
			<span className="flex min-w-0 items-center gap-2 text-sm">
				<span className="size-1.5 shrink-0 rounded-full bg-foreground" />
				<span className="shrink-0 font-medium">
					{count === 1 ? "1 unsaved change" : `${count} unsaved changes`}
				</span>
				<span className="truncate text-muted-foreground max-sm:hidden">
					· {hint}
				</span>
			</span>
			<div className="flex shrink-0 items-center gap-1">
				<Button variant="ghost" size="sm" onClick={onDiscard}>
					Discard
				</Button>
				<Button
					size="sm"
					onClick={onSave}
					isLoading={saving}
					disabled={disabled}
				>
					Save
					<SaveKey />
				</Button>
			</div>
		</FloatingBar>
	);
}
