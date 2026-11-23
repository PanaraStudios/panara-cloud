"use client";

import copy from "copy-to-clipboard";
import {
	CheckIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	CopyIcon,
	ListFilterIcon,
	XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { highlight } from "./log-text";

export function CopyButton({ text, label }: { text: string; label: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<Button
			variant="ghost"
			size="icon-xs"
			aria-label={label}
			title={label}
			onClick={() => setCopied(copy(text))}
		>
			{copied ? <CheckIcon /> : <CopyIcon />}
		</Button>
	);
}

/** One part of the panel: a small title, its copy button, then the content
    flat on the panel. Parts are split by a hairline, never boxed. */
export function Block({
	title,
	count,
	copyText,
	copyLabel,
	actions,
	children,
}: {
	title: string;
	count?: number;
	copyText?: string;
	copyLabel?: string;
	actions?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="flex flex-col gap-1.5 border-border border-b px-4 py-3 last:border-b-0">
			<div className="flex h-6 items-center justify-between gap-2">
				<h3 className="font-medium text-muted-foreground text-xs">
					{title}
					{count !== undefined ? (
						<span className="ml-1.5 font-normal tabular-nums">{count}</span>
					) : null}
				</h3>
				<div className="flex items-center">
					{actions}
					{copyText !== undefined ? (
						<CopyButton
							text={copyText}
							label={copyLabel ?? `Copy ${title.toLowerCase()}`}
						/>
					) : null}
				</div>
			</div>
			{children}
		</section>
	);
}

export const PRE =
	"whitespace-pre-wrap font-mono text-[13px] text-terminal-foreground/90 leading-5 [overflow-wrap:anywhere]";

/** The two-column grid a panel's facts sit in: a label, then its value. */
export function Facts({ children }: { children: ReactNode }) {
	return (
		<dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] sm:grid-cols-[8.5rem_minmax(0,1fr)]">
			{children}
		</dl>
	);
}

export function Fact({
	label,
	children,
	className,
}: {
	label: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<>
			<dt className="text-muted-foreground">{label}</dt>
			<dd
				className={cn("min-w-0 font-mono [overflow-wrap:anywhere]", className)}
			>
				{children}
			</dd>
		</>
	);
}

const NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** How a value reads by what it is: a number, a boolean, nothing, or text. */
export const valueTone = (value: unknown) =>
	value === null || value === undefined || value === "null"
		? "text-terminal-foreground/40"
		: typeof value === "number" ||
				(typeof value === "string" && NUMBER.test(value))
			? "text-info"
			: typeof value === "boolean" || value === "true" || value === "false"
				? "text-warning"
				: "text-terminal-foreground/90";

/** The buttons a value shows on hover: filter the list by it, copy it. */
export function ValueActions({
	name,
	value,
	copyText,
	onFilter,
}: {
	name: string;
	value: string;
	copyText?: string;
	onFilter?: (value: string) => void;
}) {
	return (
		<span className="absolute top-0 right-0 flex bg-terminal opacity-0 focus-within:opacity-100 group-hover/value:opacity-100 max-md:hidden">
			{onFilter ? (
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label={`Filter by ${name}`}
					title="Filter by this value"
					onClick={() => onFilter(value)}
				>
					<ListFilterIcon />
				</Button>
			) : null}
			<CopyButton text={copyText ?? value} label={`Copy ${name}`} />
		</span>
	);
}

/** Named values, one per row: the fields of a logfmt line, the headers of a
    request. Each can be filtered by or copied. */
export function FieldList({
	fields,
	pattern,
	onFilter,
}: {
	fields: readonly { key: string; value: string }[];
	pattern?: RegExp | null;
	onFilter?: (value: string) => void;
}) {
	return (
		<dl className="flex flex-col font-mono text-[13px] leading-5">
			{fields.map((field) => (
				<div
					key={field.key}
					className="group/value relative grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 py-[3px] sm:grid-cols-[8.5rem_minmax(0,1fr)]"
				>
					<dt className="break-all text-terminal-foreground/55">
						{highlight(field.key, pattern ?? null)}
					</dt>
					<dd
						className={cn(
							"whitespace-pre-wrap [overflow-wrap:anywhere] md:pr-12",
							valueTone(field.value),
						)}
					>
						{field.value === "" ? (
							<span className="text-terminal-foreground/40">empty</span>
						) : (
							highlight(field.value, pattern ?? null)
						)}
					</dd>
					{field.value !== "" ? (
						<ValueActions
							name={field.key}
							value={field.value}
							onFilter={onFilter}
						/>
					) : null}
				</div>
			))}
		</dl>
	);
}

interface Props {
	/** What the panel is, for assistive tech: "Log entry", "Request". */
	label: string;
	/** What one row is called on its buttons: "entry", "request". */
	noun: string;
	/** The heading: what was picked, in a few words. */
	title: ReactNode;
	/** The whole row as text, for the copy button in the heading. */
	copyText: string;
	hasPrevious: boolean;
	hasNext: boolean;
	onMove: (step: -1 | 1) => void;
	onClose: () => void;
	children: ReactNode;
}

/** The whole of one row, beside the list. */
export function DetailPanel({
	label,
	noun,
	title,
	copyText,
	hasPrevious,
	hasNext,
	onMove,
	onClose,
	children,
}: Props) {
	return (
		<aside
			aria-label={label}
			className="flex min-w-0 flex-col bg-terminal max-md:absolute max-md:inset-0 max-md:z-10 md:w-[26rem] md:shrink-0 md:border-border md:border-l lg:w-[30rem]"
		>
			<header className="flex h-9 shrink-0 items-center gap-2.5 border-border border-b pr-1.5 pl-4">
				{title}
				<div className="ml-auto flex shrink-0 items-center">
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={`Previous ${noun}`}
						title={`Previous ${noun}`}
						disabled={!hasPrevious}
						onClick={() => onMove(-1)}
					>
						<ChevronUpIcon />
					</Button>
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={`Next ${noun}`}
						title={`Next ${noun}`}
						disabled={!hasNext}
						onClick={() => onMove(1)}
					>
						<ChevronDownIcon />
					</Button>
					<CopyButton text={copyText} label={`Copy ${noun}`} />
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={`Close ${noun}`}
						title="Close"
						onClick={onClose}
					>
						<XIcon />
					</Button>
				</div>
			</header>
			<div className="custom-logs-scrollbar min-h-0 flex-1 overflow-y-auto">
				{children}
			</div>
			<footer className="flex h-8 shrink-0 items-center gap-3 border-border border-t px-4 text-muted-foreground text-xs max-md:hidden">
				<span className="flex items-center gap-1">
					<Kbd>↑</Kbd>
					<Kbd>↓</Kbd>
					Move
				</span>
				<span className="flex items-center gap-1">
					<Kbd>Esc</Kbd>
					Close
				</span>
			</footer>
		</aside>
	);
}
