"use client";

import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { nestedJson } from "@/lib/log-entries";
import { cn } from "@/lib/utils";
import { ValueActions, valueTone } from "./detail-panel";
import { highlight } from "./log-text";

/** Objects and arrays this deep and deeper start closed. */
const OPEN_DEPTH = 2;
/** Children of one object or array shown before "Show more". */
const PAGE = 100;
/** A short list of plain values stays on its line. */
const INLINE_LENGTH = 56;

const FAINT = "text-terminal-foreground/35";
const KEY = "text-terminal-foreground/55";

type Container = Record<string, unknown> | unknown[];

const isContainer = (value: unknown): value is Container =>
	value !== null && typeof value === "object";

const childrenOf = (value: Container): [string | null, unknown][] =>
	Array.isArray(value)
		? value.map((item) => [null, item])
		: Object.entries(value);

function inlineList(value: unknown): string | null {
	if (!Array.isArray(value) || value.some(isContainer)) return null;
	const text = JSON.stringify(value);
	return text.length <= INLINE_LENGTH ? text.replace(/,/g, ", ") : null;
}

const countOf = (value: Container) => {
	const size = Array.isArray(value) ? value.length : Object.keys(value).length;
	const noun = Array.isArray(value)
		? size === 1
			? "item"
			: "items"
		: size === 1
			? "key"
			: "keys";
	return `${size.toLocaleString()} ${noun}`;
};

interface Shared {
	pattern: RegExp | null;
	onFilter?: (value: string) => void;
	open: ReadonlyMap<string, boolean>;
	more: ReadonlyMap<string, number>;
	toggle: (path: string, open: boolean) => void;
	showMore: (path: string) => void;
}

function Line({
	depth,
	toggle,
	className,
	children,
}: {
	depth: number;
	/** The open/close control of an object or array, in the gutter. */
	toggle?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	return (
		<div
			className={cn("group/value relative flex", className)}
			style={{ paddingLeft: depth * 14 }}
		>
			<span className="flex h-5 w-3.5 shrink-0 items-center">{toggle}</span>
			<span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere] md:pr-12">
				{children}
			</span>
		</div>
	);
}

function Name({
	name,
	pattern,
}: {
	name: string | null;
	pattern: RegExp | null;
}) {
	if (name === null) return null;
	return (
		<>
			<span className={KEY}>
				<span className={FAINT}>"</span>
				{highlight(name, pattern)}
				<span className={FAINT}>"</span>
			</span>
			<span className={FAINT}>: </span>
		</>
	);
}

function Node({
	name,
	value,
	path,
	depth,
	last,
	parsed,
	shared,
}: {
	name: string | null;
	value: unknown;
	path: string;
	depth: number;
	last: boolean;
	/** The value was a string holding JSON: its own strings are left alone. */
	parsed: boolean;
	shared: Shared;
}) {
	const { pattern, onFilter } = shared;
	const comma = last ? null : <span className={FAINT}>,</span>;
	const inner =
		!parsed && typeof value === "string" ? nestedJson(value) : undefined;
	const container = isContainer(value)
		? value
		: isContainer(inner)
			? inner
			: null;
	const label = name ?? "value";

	if (container === null || inlineList(container) !== null) {
		const text =
			container !== null
				? (inlineList(container) ?? "")
				: typeof value === "string"
					? value
					: String(value);
		return (
			<Line depth={depth}>
				<Name name={name} pattern={pattern} />
				{container !== null ? (
					<span className="text-terminal-foreground/90">
						{highlight(text, pattern)}
					</span>
				) : typeof value === "string" ? (
					<span className={valueTone(null)}>
						"
						<span className="text-terminal-foreground/90">
							{highlight(value, pattern)}
						</span>
						"
					</span>
				) : (
					<span className={valueTone(value)}>{highlight(text, pattern)}</span>
				)}
				{comma}
				<ValueActions
					name={label}
					value={text}
					copyText={
						name === null
							? JSON.stringify(value)
							: `${JSON.stringify(name)}: ${JSON.stringify(value)}`
					}
					onFilter={text === "" ? undefined : onFilter}
				/>
			</Line>
		);
	}

	const items = childrenOf(container);
	const [opening, closing] = Array.isArray(container) ? "[]" : "{}";
	const open = shared.open.get(path) ?? depth < OPEN_DEPTH;
	const limit = shared.more.get(path) ?? PAGE;
	// The whole value has nothing to fold into.
	const toggle =
		depth === 0 ? undefined : (
			<button
				type="button"
				aria-expanded={open}
				aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
				onClick={() => shared.toggle(path, !open)}
				className="-ml-0.5 flex size-4 items-center justify-center rounded-sm text-terminal-foreground/45 outline-none hover:bg-terminal-foreground/10 hover:text-terminal-foreground focus-visible:ring-2 focus-visible:ring-ring"
			>
				<ChevronRightIcon
					className={cn("size-3 transition-transform", open && "rotate-90")}
				/>
			</button>
		);
	const note = (
		<span className="select-none font-sans text-terminal-foreground/45 text-xs">
			{inner !== undefined ? "JSON in a string · " : ""}
			{countOf(container)}
		</span>
	);
	if (!open || items.length === 0) {
		return (
			<Line depth={depth} toggle={items.length > 0 ? toggle : undefined}>
				<Name name={name} pattern={pattern} />
				<span className={FAINT}>
					{opening}
					{items.length > 0 ? "…" : ""}
					{closing}
				</span>
				{comma}
				{items.length > 0 ? <> {note}</> : null}
				<ValueActions
					name={label}
					value=""
					copyText={JSON.stringify(container, null, 2)}
				/>
			</Line>
		);
	}
	return (
		<>
			<Line depth={depth} toggle={toggle}>
				<Name name={name} pattern={pattern} />
				<span className={FAINT}>{opening}</span>
				{inner !== undefined ? <> {note}</> : null}
				<ValueActions
					name={label}
					value=""
					copyText={JSON.stringify(container, null, 2)}
				/>
			</Line>
			{items.slice(0, limit).map(([key, item], index) => (
				<Node
					key={key ?? index}
					name={key}
					value={item}
					path={`${path}/${key ?? index}`}
					depth={depth + 1}
					last={index === items.length - 1}
					parsed={parsed || inner !== undefined}
					shared={shared}
				/>
			))}
			{items.length > limit ? (
				<Line depth={depth + 1}>
					<button
						type="button"
						onClick={() => shared.showMore(path)}
						className="rounded-sm font-sans text-terminal-foreground/60 text-xs underline-offset-2 outline-none hover:text-terminal-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
					>
						Show {Math.min(PAGE, items.length - limit).toLocaleString()} more of{" "}
						{(items.length - limit).toLocaleString()}
					</button>
				</Line>
			) : null}
			<Line depth={depth}>
				<span className={FAINT}>{closing}</span>
				{comma}
			</Line>
		</>
	);
}

/**
 * A JSON value laid out to be read: one key per line, values toned by what
 * they are, nested objects folded past the second level with their size. A
 * string that itself holds JSON opens one level further. Any value can be
 * copied or put in the search.
 */
export function JsonTree({
	value,
	pattern,
	onFilter,
}: {
	value: unknown;
	pattern: RegExp | null;
	onFilter?: (value: string) => void;
}) {
	const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
	const [more, setMore] = useState<ReadonlyMap<string, number>>(new Map());
	return (
		<div className="font-mono text-[13px] leading-5">
			<Node
				name={null}
				value={value}
				path=""
				depth={0}
				last
				parsed={false}
				shared={{
					pattern,
					onFilter,
					open,
					more,
					toggle: (path, next) =>
						setOpen((current) => new Map(current).set(path, next)),
					showMore: (path) =>
						setMore((current) =>
							new Map(current).set(path, (current.get(path) ?? PAGE) + PAGE),
						),
				}}
			/>
		</div>
	);
}
