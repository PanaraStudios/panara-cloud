"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import {
	type CSSProperties,
	memo,
	type ReactNode,
	type Ref,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
} from "react";
import { cn } from "@/lib/utils";

/** Height of a row that shows one line; the list is laid out from it. */
export const ROW_HEIGHT = 26;

/** The slot at the end of the heading that holds Pause and Go live. Rows
    leave the same room when a column's heading would otherwise sit there.
    Wide enough for "Go live · 9,999 new"; a list with less room keeps the
    button and counts on a badge, and a narrow one keeps only the icon. */
export const LIVE_SLOT =
	"w-36 shrink-0 @max-4xl/viewer:w-[5.5rem] @max-2xl/viewer:w-7";

export type RowTone = "error" | "warn" | null;

export interface CellState {
	wrap: boolean;
	selected: boolean;
	/** The search, as a global expression, for marking matches. */
	pattern: RegExp | null;
}

/**
 * One column of a viewer. `className` sizes the slot for the heading and for
 * every row, so columns line up; the column without a width takes the rest.
 */
export interface ViewerColumn<T> {
	id: string;
	header: ReactNode;
	className?: string;
	style?: CSSProperties;
	cellClassName?: string | ((row: T, state: CellState) => string | undefined);
	title?: (row: T) => string | undefined;
	cell: (row: T, state: CellState) => ReactNode;
	/** No slot at all in a row where `cell` gives null (and no heading). */
	optional?: boolean;
	/** The column that takes the width left over. */
	grow?: boolean;
}

const ROW_TINT: Record<"error" | "warn", string> = {
	error:
		"bg-destructive/[0.07] hover:bg-destructive/[0.12] dark:bg-destructive/[0.11] dark:hover:bg-destructive/[0.17]",
	warn: "bg-warning/[0.08] hover:bg-warning/[0.13] dark:bg-warning/[0.09] dark:hover:bg-warning/[0.14]",
};

const SELECTED: Record<"error" | "warn" | "plain", string> = {
	error: "bg-destructive/[0.16]",
	warn: "bg-warning/[0.18]",
	plain: "bg-terminal-foreground/[0.09]",
};

export const ROW_GAP = "gap-4 max-sm:gap-3";

interface RowProps<T> {
	row: T;
	// A row can be updated in place: a new stamp makes it render again.
	stamp: unknown;
	columns: readonly ViewerColumn<T>[];
	tone: RowTone;
	selected: boolean;
	wrap: boolean;
	pattern: RegExp | null;
	/** Leave the room the heading's live control takes. */
	reserve: boolean;
	onSelect: (row: T) => void;
}

function ViewerRowInner<T>({
	row,
	columns,
	tone,
	selected,
	wrap,
	pattern,
	reserve,
	onSelect,
}: RowProps<T>) {
	const state: CellState = { wrap, selected, pattern };
	return (
		<div
			onClick={() => onSelect(row)}
			className={cn(
				"flex cursor-default px-4 font-mono text-[13px]",
				ROW_GAP,
				wrap ? "items-start py-[3px] leading-5" : "items-center",
				selected
					? SELECTED[tone ?? "plain"]
					: tone
						? ROW_TINT[tone]
						: "hover:bg-terminal-foreground/[0.05]",
				selected && "shadow-[inset_2px_0_0_var(--foreground)]",
			)}
			style={wrap ? { minHeight: ROW_HEIGHT } : { height: ROW_HEIGHT }}
		>
			{columns.map((column) => {
				const content = column.cell(row, state);
				if (content === null && column.optional) return null;
				return (
					<span
						key={column.id}
						title={column.title?.(row)}
						style={column.style}
						className={cn(
							column.className,
							typeof column.cellClassName === "function"
								? column.cellClassName(row, state)
								: column.cellClassName,
						)}
					>
						{content}
					</span>
				);
			})}
			{reserve ? <span className={LIVE_SLOT} /> : null}
		</div>
	);
}

const ViewerRow = memo(ViewerRowInner) as typeof ViewerRowInner;

export interface ViewerListHandle {
	scrollToIndex: (index: number) => void;
	/** The first or last row on screen: where the arrow keys start from. */
	edge: (end: "first" | "last") => number;
	pageSize: () => number;
	focus: () => void;
	contains: (node: Node) => boolean;
}

interface Props<T> {
	ref: Ref<ViewerListHandle>;
	label: string;
	/** The row at a place in the list, top to bottom. */
	rowAt: (index: number) => T | undefined;
	// The rows are updated in place: these tell the list something changed.
	count: number;
	version: unknown;
	rowId: (row: T) => string | number;
	rowStamp?: (row: T) => unknown;
	rowTone?: (row: T) => RowTone;
	/** A row that only divides the list: drawn whole and never selected. */
	divider?: (row: T, pattern: RegExp | null) => ReactNode | null;
	columns: readonly ViewerColumn<T>[];
	wrap: boolean;
	cursor: T | null;
	pattern: RegExp | null;
	/** Which end new rows arrive at: the top (newest first) or the bottom. */
	liveEnd: "top" | "bottom";
	/** Keep the newest row in view. */
	following: boolean;
	/** The detail panel is open, which narrows the rows. */
	narrowed: boolean;
	/** Rows leave room for the heading's live control. */
	reserve: boolean;
	/** How many rows have been added above the first since the list was
	    shown: the view stays on what it showed. */
	addedAbove: number;
	/** Past the oldest row: a way to load more. */
	end?: ReactNode;
	onSelect: (row: T) => void;
	/** The reader scrolled; `atLive` when they reached the newest row. */
	onReaderScroll: (atLive: boolean) => void;
	/** Shown when there are no rows. */
	children: ReactNode;
}

function ViewerListInner<T>({
	ref,
	label,
	rowAt,
	count,
	rowId,
	rowStamp,
	rowTone,
	divider,
	columns,
	wrap,
	cursor,
	pattern,
	liveEnd,
	following,
	narrowed,
	reserve,
	addedAbove,
	end,
	onSelect,
	onReaderScroll,
	children,
}: Props<T>) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const intent = useRef(0);
	const held = useRef(false);

	const virtualizer = useVirtualizer({
		count,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_HEIGHT,
		getItemKey: (index) => {
			const row = rowAt(index);
			return row === undefined ? index : rowId(row);
		},
		overscan: 8,
		paddingStart: 6,
		paddingEnd: 6,
	});
	useEffect(() => {
		virtualizer.measure();
	}, [wrap, narrowed]);

	// Runs after every render: rows measured late (wrapped lines) would
	// otherwise leave the newest row just out of view.
	useLayoutEffect(() => {
		if (!following) return;
		const element = scrollRef.current;
		if (element) {
			element.scrollTop = liveEnd === "top" ? 0 : element.scrollHeight;
		}
	});

	// A scrollbar that takes room narrows the rows; the heading above takes
	// the same room so its columns stay over theirs.
	useLayoutEffect(() => {
		const element = scrollRef.current;
		element?.parentElement?.style.setProperty(
			"--viewer-gutter",
			`${element.offsetWidth - element.clientWidth}px`,
		);
	});

	// Rows added above what is on screen push it down: the view moves with
	// it, so the reader keeps their place. At the very top of a list whose
	// newest row is first, the reader is there for what arrives.
	const seenAbove = useRef(addedAbove);
	useLayoutEffect(() => {
		const added = addedAbove - seenAbove.current;
		seenAbove.current = addedAbove;
		const element = scrollRef.current;
		if (added <= 0 || !element || following) return;
		if (liveEnd === "top" && element.scrollTop === 0) return;
		element.scrollTop += added * ROW_HEIGHT;
	}, [addedAbove, following, liveEnd]);

	useEffect(() => {
		const release = () => {
			held.current = false;
		};
		window.addEventListener("pointerup", release);
		window.addEventListener("pointercancel", release);
		return () => {
			window.removeEventListener("pointerup", release);
			window.removeEventListener("pointercancel", release);
		};
	}, []);
	const markIntent = () => {
		intent.current = performance.now();
	};
	const onScroll = () => {
		// Only a scroll the reader made counts: rows changing height and a
		// filter shortening the list move the position too. A flick keeps
		// scrolling after the finger lifts, so each such scroll extends the
		// window for the next.
		const now = performance.now();
		if (!held.current && now - intent.current > 250) return;
		intent.current = now;
		const element = scrollRef.current;
		if (!element) return;
		onReaderScroll(
			liveEnd === "top"
				? element.scrollTop < 8
				: element.scrollHeight - element.scrollTop - element.clientHeight < 8,
		);
	};

	useImperativeHandle(
		ref,
		() => ({
			scrollToIndex: (index) =>
				virtualizer.scrollToIndex(index, { align: "auto" }),
			edge: (end) => {
				const items = virtualizer.getVirtualItems();
				const element = scrollRef.current;
				if (!element || items.length === 0) return 0;
				const top = element.scrollTop;
				const bottom = top + element.clientHeight;
				const onScreen = items.filter(
					(item) => item.end > top && item.start < bottom,
				);
				const item = end === "first" ? onScreen[0] : onScreen.at(-1);
				return item?.index ?? 0;
			},
			pageSize: () =>
				Math.max(
					1,
					Math.floor((scrollRef.current?.clientHeight ?? 0) / ROW_HEIGHT) - 1,
				),
			focus: () => scrollRef.current?.focus({ preventScroll: true }),
			contains: (node) => !!scrollRef.current?.contains(node),
		}),
		[virtualizer],
	);

	return (
		<div
			ref={scrollRef}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the arrow keys move through the rows from here.
			tabIndex={0}
			onScroll={onScroll}
			onWheel={markIntent}
			onTouchMove={markIntent}
			onPointerDown={() => {
				held.current = true;
				markIntent();
			}}
			className="custom-logs-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden outline-none"
		>
			{count === 0 ? (
				<div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-sm text-terminal-foreground/50">
					{children}
				</div>
			) : (
				<>
					{liveEnd === "bottom" ? end : null}
					{/* A plain list: the panel's shortcuts stand down while a listbox
					    is on screen, as they do for an open menu. */}
					<ul
						aria-label={label}
						className="relative w-full"
						style={{ height: virtualizer.getTotalSize() }}
					>
						{virtualizer.getVirtualItems().map((item) => {
							const row = rowAt(item.index);
							if (row === undefined) return null;
							const whole = divider?.(row, pattern) ?? null;
							return (
								<li
									key={item.key}
									data-index={item.index}
									aria-current={row === cursor ? "true" : undefined}
									ref={wrap ? virtualizer.measureElement : undefined}
									className="absolute top-0 left-0 w-full"
									style={{ transform: `translateY(${item.start}px)` }}
								>
									{whole ?? (
										<ViewerRow
											row={row}
											stamp={rowStamp?.(row)}
											columns={columns}
											tone={rowTone?.(row) ?? null}
											selected={row === cursor}
											wrap={wrap}
											pattern={pattern}
											reserve={reserve}
											onSelect={onSelect}
										/>
									)}
								</li>
							);
						})}
					</ul>
					{liveEnd === "top" ? end : null}
				</>
			)}
		</div>
	);
}

// Scrolling renders this component only: the toolbar and the panel beside it
// stay as they are.
export const ViewerList = memo(ViewerListInner) as typeof ViewerListInner;
