"use client";

import copy from "copy-to-clipboard";
import {
	ArrowDownIcon,
	ArrowUpIcon,
	CalendarArrowDownIcon,
	CalendarArrowUpIcon,
	CheckIcon,
	CopyIcon,
	PauseIcon,
	SearchIcon,
	WrapTextIcon,
	XIcon,
} from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@/components/ui/input-group";
import { isTypingTarget } from "@/lib/dashboard/use-shortcut";
import { cn } from "@/lib/utils";
import {
	displayOrder,
	readOrder,
	type ViewerOrder,
	waitingCount,
	writeOrder,
} from "@/lib/viewer-order";
import {
	LIVE_SLOT,
	ROW_GAP,
	type RowTone,
	type ViewerColumn,
	ViewerList,
	type ViewerListHandle,
} from "./viewer-list";

const OVERLAYS =
	'[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"][data-slot], [data-slot="popover-content"]';

export type ViewerStatus = "live" | "connecting" | "offline";

/** A narrow list (the detail panel is open) keeps the live button's icon. */
const NARROW_HIDDEN = "@max-2xl/viewer:hidden";
/** The count of waiting rows is spelled out only where the slot has room. */
const COUNT_HIDDEN = "@max-4xl/viewer:hidden";

/** What a detail panel needs from the viewer that opened it. */
export interface DetailControls {
	pattern: RegExp | null;
	hasPrevious: boolean;
	hasNext: boolean;
	onMove: (step: -1 | 1) => void;
	onClose: () => void;
}

interface Props<T> {
	/** What the list is, for assistive tech: "Log lines", "Requests". */
	label: string;
	/** The kind of list ("container", "deployment", "requests"): the order
	    chosen for one is remembered for every list of that kind. */
	kind: string;
	/** The rows to show, in time order (oldest first): already filtered, and
	    held back while the tail is paused. The shell turns them over when the
	    newest goes on top. */
	rows: readonly T[];
	/** Changes when rows were added or updated in place. */
	version?: unknown;
	rowId: (row: T) => string | number;
	rowStamp?: (row: T) => unknown;
	rowTone?: (row: T) => RowTone;
	divider?: (row: T, pattern: RegExp | null) => ReactNode | null;
	/** Whether a row is such a divider: it stays above its section when the
	    newest goes on top. */
	isDivider?: (row: T) => boolean;
	/** The row is no longer in the data at all (a cleared or trimmed buffer). */
	isGone?: (row: T) => boolean;
	columns: readonly ViewerColumn<T>[];
	/** The whole of one row, in a `DetailPanel`. */
	detail: (row: T, controls: DetailControls) => ReactNode;

	/** false leaves only the list: for a short log inside another page. */
	toolbar?: boolean;
	search: string;
	onSearch: (value: string) => void;
	searchLabel: string;
	/** The search as a global expression: matches are marked in the rows. */
	pattern: RegExp | null;
	/** Filters and pickers after the search. */
	filters?: ReactNode;
	/** Controls before wrap, copy and download. */
	actions?: ReactNode;
	/** Controls after download. */
	after?: ReactNode;
	/** Between the toolbar and the list: figures the filters above it shape. */
	banner?: ReactNode;
	wrap: boolean;
	onWrap: (wrap: boolean) => void;
	/** The rows as text, for copy and download. */
	text: () => string;
	rowText: (row: T) => string;
	/** Name of the downloaded file, with its extension. */
	fileName: () => string;
	copyLabel: string;

	/** How much is listed, shown in the search box: "171 lines", "12 of 300". */
	summary?: ReactNode;
	/** New rows keep arriving: the view stays on the newest and can be paused. */
	follow?: boolean;
	status?: ViewerStatus;
	/** Rows that arrived while paused. */
	pending?: number;
	/** The tail was paused or resumed: the page holds its rows back meanwhile. */
	onPausedChange?: (paused: boolean) => void;
	/** Rows added before the oldest one since the list was shown. */
	prepended?: number;
	/** Past the oldest row: a way to load more. */
	end?: ReactNode;
	/** Shown in the list while there is nothing to show. */
	empty: ReactNode;
	/** Height of the viewer (and any full-bleed tweaks); the surface is its own. */
	className?: string;
	/** A new value means different data: selection and pause start over. */
	resetKey?: string;
}

/**
 * The frame every log-like list in the panel shares: a toolbar (search,
 * filters, then wrap, copy and download), dense monospace rows under one
 * heading, a panel beside the list for the row you pick, and a tail that
 * pauses when you scroll away from it. What the rows are is the caller's:
 * it gives the columns and the panel.
 */
export function ViewerShell<T>({
	label,
	kind,
	rows,
	version,
	rowId,
	rowStamp,
	rowTone,
	divider,
	isDivider,
	isGone,
	columns,
	detail,
	toolbar = true,
	search,
	onSearch,
	searchLabel,
	pattern,
	filters,
	actions,
	after,
	banner,
	wrap,
	onWrap,
	text,
	rowText,
	fileName,
	copyLabel,
	summary,
	follow = false,
	status = "live",
	pending = 0,
	onPausedChange,
	prepended = 0,
	end,
	empty,
	className,
	resetKey,
}: Props<T>) {
	const [paused, setPaused] = useState(false);
	// Newest first until the device says otherwise; read after mounting so
	// the server and the first render agree.
	const [order, setOrder] = useState<ViewerOrder>("newest");
	useEffect(() => setOrder(readOrder(kind)), [kind]);
	// What paused the tail decides what resumes it: the button only the
	// button, a scroll the way back to the newest row, an opened row its
	// closing.
	const pausedBy = useRef<"button" | "scroll" | "entry" | null>(null);
	const [cursor, setCursor] = useState<T | null>(null);
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<ViewerListHandle>(null);
	const onPaused = useRef(onPausedChange);
	onPaused.current = onPausedChange;

	useEffect(() => {
		pausedBy.current = null;
		setPaused(false);
		onPaused.current?.(false);
		setCursor(null);
		setOpen(false);
	}, [resetKey]);

	const following = follow && !paused;

	const pause = useCallback((by: "button" | "scroll" | "entry") => {
		const current = pausedBy.current;
		if (current === null) onPaused.current?.(true);
		// A row opened while already scrolled away stays paused when it closes.
		if (current === null || by === "button" || current === "entry") {
			pausedBy.current = by;
		}
		setPaused(true);
	}, []);
	const resume = useCallback(() => {
		pausedBy.current = null;
		setPaused(false);
		onPaused.current?.(false);
	}, []);

	const onReaderScroll = useCallback(
		(atLive: boolean) => {
			if (!follow) return;
			if (!atLive) pause("scroll");
			else if (pausedBy.current === "scroll" && !open) resume();
		},
		[follow, open, pause, resume],
	);

	const dividers = useMemo(() => {
		const places: number[] = [];
		if (!isDivider || order === "oldest") return places;
		for (let place = 0; place < rows.length; place++) {
			if (isDivider(rows[place] as T)) places.push(place);
		}
		return places;
	}, [rows, version, isDivider, order]);
	const layout = useMemo(
		() => displayOrder(rows.length, order, dividers),
		[rows.length, order, dividers],
	);
	const rowAt = useCallback(
		(place: number) => rows[layout.toChrono(place)],
		[rows, version, layout],
	);
	const kept = cursor ? rows.indexOf(cursor) : -1;
	const index = kept === -1 ? -1 : layout.toDisplay(kept);

	// Rows that arrived above the top of the list since it was shown. A
	// filter changes the rows wholesale: only growth that left the old top
	// row where it would be counts.
	const top = rows.length > 0 ? rowAt(0) : undefined;
	const seen = useRef({
		count: 0,
		prepended: 0,
		top: undefined as unknown,
		above: 0,
	});
	{
		const before = seen.current;
		const grown = rows.length - before.count;
		const older = prepended - before.prepended;
		const above = order === "newest" ? grown - older : older;
		if (above > 0 && before.count > 0) {
			const moved = rowAt(above);
			if (moved !== undefined && rowId(moved) === before.top) {
				before.above += above;
			}
		}
		before.count = rows.length;
		before.prepended = prepended;
		before.top = top === undefined ? undefined : rowId(top);
	}
	const addedAbove = seen.current.above;
	const select = useCallback(
		(row: T) => {
			setCursor(row);
			setOpen(true);
			if (follow) pause("entry");
		},
		[follow, pause],
	);
	const close = () => {
		setOpen(false);
		listRef.current?.focus();
		if (pausedBy.current === "entry") resume();
	};
	const divides = (row: T | undefined) =>
		row !== undefined &&
		(isDivider ? isDivider(row) : !!divider && divider(row, null) !== null);
	const move = (step: number, to?: "start" | "end") => {
		if (rows.length === 0) return;
		let next: number;
		if (to) next = to === "start" ? 0 : rows.length - 1;
		else if (index === -1) {
			next = listRef.current?.edge(step > 0 ? "first" : "last") ?? 0;
		} else next = index + step;
		next = Math.max(0, Math.min(rows.length - 1, next));
		const direction = step < 0 || to === "end" ? -1 : 1;
		while (divides(rowAt(next))) {
			const further = next + direction;
			if (further < 0 || further >= rows.length) break;
			next = further;
		}
		const row = rowAt(next);
		if (row === undefined || divides(row)) return;
		setCursor(row);
		if (follow) pause("entry");
		listRef.current?.scrollToIndex(next);
	};

	const keys = useRef<(event: KeyboardEvent) => void>(() => {});
	keys.current = (event) => {
		const root = rootRef.current;
		const target = event.target instanceof Element ? event.target : null;
		if (!root || event.defaultPrevented || event.altKey) return;
		const inList = !!target && !!listRef.current?.contains(target);
		if (!open && !inList) return;
		const overlay = target?.closest(OVERLAYS);
		if (overlay && !overlay.contains(root)) return;
		if (isTypingTarget(target)) {
			if (event.key === "Escape" && open) {
				event.preventDefault();
				close();
			}
			return;
		}
		const page = listRef.current?.pageSize() ?? 1;
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
			if (!cursor || !window.getSelection()?.isCollapsed) return;
			event.preventDefault();
			if (copy(rowText(cursor))) toast.success("Copied");
			return;
		}
		if (event.metaKey || event.ctrlKey) return;
		switch (event.key) {
			case "ArrowDown":
				move(1);
				break;
			case "ArrowUp":
				move(-1);
				break;
			case "PageDown":
				move(page);
				break;
			case "PageUp":
				move(-page);
				break;
			case "Home":
				move(-1, "start");
				break;
			case "End":
				move(1, "end");
				break;
			case "Enter":
			case " ":
				if (!cursor || !inList) return;
				setOpen(true);
				break;
			case "Escape":
				if (!open) return;
				close();
				break;
			default:
				return;
		}
		event.preventDefault();
	};
	useEffect(() => {
		// On the document, ahead of the page's own shortcuts: Esc closes the
		// row before it means "back".
		const onKeyDown = (event: KeyboardEvent) => keys.current(event);
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	const cursorGone = cursor !== null && !!isGone?.(cursor);
	useEffect(() => {
		if (!cursorGone) return;
		setCursor(null);
		setOpen(false);
	}, [cursorGone]);

	const download = () => {
		const url = URL.createObjectURL(new Blob([text()], { type: "text/plain" }));
		const link = document.createElement("a");
		link.href = url;
		link.download = fileName();
		link.click();
		URL.revokeObjectURL(url);
	};

	const shown = open && cursor !== null && !cursorGone ? cursor : null;
	const headings = columns.filter((column) => !column.optional);
	const newest = order === "newest";
	// A heading after the growing column would sit where the live control
	// is: its rows leave that room too, so it stays over them.
	const reserve = follow && headings.at(-1)?.grow !== true;
	const goLive = () => {
		resume();
		listRef.current?.scrollToIndex(newest ? 0 : rows.length - 1);
		listRef.current?.focus();
	};
	const changeOrder = () => {
		const next: ViewerOrder = newest ? "oldest" : "newest";
		writeOrder(kind, next);
		setOrder(next);
		// Start again from the live end, or from the top of a finished list.
		if (follow) resume();
		requestAnimationFrame(() =>
			listRef.current?.scrollToIndex(
				!follow || next === "newest" ? 0 : rows.length - 1,
			),
		);
	};
	const LiveArrow = newest ? ArrowUpIcon : ArrowDownIcon;
	// Rows held back while paused are counted on the button that shows them.
	const waiting = paused && pending > 0 ? waitingCount(pending) : null;

	return (
		<div className="flex min-w-0 flex-col gap-3">
			{toolbar ? (
				<div className="flex flex-wrap items-center gap-2 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:*:shrink-0">
					<InputGroup className="h-8 w-72 max-w-full max-sm:w-52">
						<InputGroupAddon>
							<SearchIcon className="size-3.5" />
						</InputGroupAddon>
						<InputGroupInput
							type="search"
							aria-label={searchLabel}
							placeholder={searchLabel}
							value={search}
							onChange={(event) => onSearch(event.target.value)}
							className="text-[13px] [&::-webkit-search-cancel-button]:hidden"
						/>
						{summary || search ? (
							<InputGroupAddon align="inline-end">
								{/* How much is listed sits where a search says what it
								    found: it costs the toolbar no room. */}
								{summary ? (
									<span className="whitespace-nowrap text-muted-foreground text-xs tabular-nums">
										{summary}
									</span>
								) : null}
								{search ? (
									<InputGroupButton
										size="icon-xs"
										aria-label="Clear search"
										onClick={() => onSearch("")}
									>
										<XIcon />
									</InputGroupButton>
								) : null}
							</InputGroupAddon>
						) : null}
					</InputGroup>
					{filters}
					<div className="ml-auto flex items-center gap-1">
						{actions}
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={newest ? "Newest first" : "Oldest first"}
							title={
								newest
									? "Newest first. Click for oldest first"
									: "Oldest first. Click for newest first"
							}
							onClick={changeOrder}
						>
							{newest ? <CalendarArrowDownIcon /> : <CalendarArrowUpIcon />}
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-pressed={wrap}
							aria-label="Wrap long lines"
							title={wrap ? "Showing whole lines" : "One row per line"}
							onClick={() => onWrap(!wrap)}
							className={cn(wrap && "bg-muted text-foreground")}
						>
							<WrapTextIcon />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={copyLabel}
							title={copyLabel}
							disabled={rows.length === 0}
							onClick={() => {
								if (!copy(text())) return;
								setCopied(true);
								setTimeout(() => setCopied(false), 2000);
							}}
						>
							{copied ? <CheckIcon /> : <CopyIcon />}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="h-8"
							disabled={rows.length === 0}
							onClick={download}
						>
							Download
						</Button>
						{after}
					</div>
				</div>
			) : null}
			{banner}
			<div
				ref={rootRef}
				className={cn(
					"relative flex overflow-hidden rounded-xl border border-border bg-terminal text-terminal-foreground dark:[color-scheme:dark]",
					className ?? "h-[60vh]",
				)}
			>
				{/* A container: a column can step aside when the panel narrows the list. */}
				<div className="@container/viewer relative flex min-w-0 flex-1 flex-col">
					{/* Headings exactly as the rows lay their cells out; the live
					    control has a slot of its own at the end, so it never moves
					    or covers one. */}
					<div
						className={cn(
							"flex h-9 shrink-0 items-center border-border border-b pr-[calc(1rem+var(--viewer-gutter,0px))] pl-4 text-muted-foreground text-xs",
							ROW_GAP,
						)}
					>
						{headings.map((column) => (
							<span
								key={column.id}
								style={column.style}
								className={cn("truncate", column.className)}
							>
								{column.header}
							</span>
						))}
						{follow ? (
							<span className={cn("flex justify-end", LIVE_SLOT)}>
								{paused ? (
									<Button
										variant="outline"
										size="xs"
										className="relative"
										aria-label={
											waiting ? `Go live · ${waiting.text} new` : "Go live"
										}
										title={
											waiting
												? `Go live: show the ${pending.toLocaleString()} new ${pending === 1 ? "row" : "rows"} and follow`
												: "Go live: show new rows as they arrive"
										}
										onClick={goLive}
									>
										<LiveArrow />
										<span className={NARROW_HIDDEN}>Go live</span>
										{waiting ? (
											<>
												<span
													className={cn(
														"text-muted-foreground tabular-nums",
														COUNT_HIDDEN,
													)}
												>
													· {waiting.text} new
												</span>
												{/* Where the words don't fit, the count rides on the button. */}
												<span
													aria-hidden
													className="-top-1 -right-1.5 absolute hidden h-3.5 min-w-3.5 items-center justify-center rounded-full bg-foreground px-1 font-mono text-[9px] text-background leading-none @max-4xl/viewer:flex"
												>
													{waiting.badge}
												</span>
											</>
										) : null}
									</Button>
								) : status === "live" ? (
									<Button
										variant="ghost"
										size="xs"
										className="-mr-2"
										aria-label="Pause"
										title="Live. Pause to hold new rows back"
										onClick={() => pause("button")}
									>
										<PauseIcon />
										<span className={NARROW_HIDDEN}>Pause</span>
									</Button>
								) : (
									<span
										className="truncate"
										title={
											status === "connecting" ? "Connecting…" : "Disconnected"
										}
									>
										{status === "connecting" ? "Connecting…" : "Disconnected"}
									</span>
								)}
							</span>
						) : null}
					</div>
					<ViewerList
						ref={listRef}
						label={label}
						rowAt={rowAt}
						count={rows.length}
						version={version}
						rowId={rowId}
						rowStamp={rowStamp}
						rowTone={rowTone}
						divider={divider}
						columns={columns}
						wrap={wrap}
						cursor={cursor}
						pattern={pattern}
						liveEnd={newest ? "top" : "bottom"}
						following={following}
						narrowed={shown !== null}
						reserve={reserve}
						addedAbove={addedAbove}
						end={end}
						onSelect={select}
						onReaderScroll={onReaderScroll}
					>
						{empty}
					</ViewerList>
				</div>
				{shown !== null
					? detail(shown, {
							pattern,
							hasPrevious: index > 0,
							hasNext: index !== -1 && index < rows.length - 1,
							onMove: (step) => move(step),
							onClose: close,
						})
					: null}
			</div>
		</div>
	);
}
