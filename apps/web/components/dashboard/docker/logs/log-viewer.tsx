"use client";

import {
	BoxIcon,
	ChevronDownIcon,
	FilesIcon,
	FileTextIcon,
	ListFilterIcon,
	XIcon,
} from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useDeferredValue,
	useEffect,
	useMemo,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	entriesText,
	entryText,
	filterEntries,
	type LevelFilter,
	type LogEntry,
	levelBucket,
	searchPattern,
	sourceLabels,
} from "@/lib/log-entries";
import { cn } from "@/lib/utils";
import { AnalyzeLogs } from "./analyze-logs";
import { LogDetail } from "./log-detail";
import { entryStamp, entryTone, logColumns, sectionRow } from "./log-row";
import { readParam, writeParams } from "./url-params";
import type { LogSource } from "./use-log-buffer";
import {
	type DetailControls,
	ViewerShell,
	type ViewerStatus,
} from "./viewer-shell";

const LEVEL_OPTIONS: { value: LevelFilter; label: string; dot: string }[] = [
	{ value: "error", label: "Errors", dot: "bg-destructive" },
	{ value: "warn", label: "Warnings", dot: "bg-warning" },
	{ value: "info", label: "Info", dot: "bg-muted-foreground" },
	{ value: "debug", label: "Debug", dot: "bg-muted-foreground/50" },
	{
		value: "other",
		label: "Other",
		dot: "border border-muted-foreground/60",
	},
];
const LEVEL_VALUES = new Set(LEVEL_OPTIONS.map((option) => option.value));

function levelsFromUrl(): Set<LevelFilter> {
	// `errors=1` is how older links asked for errors only.
	if (readParam("errors") === "1") return new Set(["error"]);
	return new Set(
		readParam("levels")
			.split(",")
			.filter((value): value is LevelFilter =>
				LEVEL_VALUES.has(value as LevelFilter),
			),
	);
}

/** Index of the first entry after `id`: the buffer is ordered by id. */
function countThrough(entries: readonly LogEntry[], id: number) {
	let low = 0;
	let high = entries.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((entries[middle] as LogEntry).id <= id) low = middle + 1;
		else high = middle;
	}
	return low;
}

export type LogStatus = ViewerStatus;

interface Props {
	source: LogSource;
	/** New lines keep arriving: the view stays on the newest and can be paused. */
	follow?: boolean;
	status?: LogStatus;
	/** Shown in the list while there is nothing to show. */
	empty: ReactNode;
	/** Height of the viewer (and any full-bleed tweaks); the surface is its own. */
	className?: string;
	/** false leaves only the list: for a short log inside another page. */
	toolbar?: boolean;
	/** Controls after the filters (a container picker, a time range). */
	toolbarStart?: ReactNode;
	/** Controls before wrap, copy and download. */
	toolbarEnd?: ReactNode;
	/** Keeps the search, the levels and wrapping in the address bar. */
	urlState?: boolean;
	showTimestamps?: boolean;
	/** Name of the downloaded file, without its extension. */
	fileName?: () => string;
	analyze?: "build" | "runtime";
	/** A new value means a different log: selection and pause start over. */
	resetKey?: string;
	/** What kind of log this is ("container", "deployment", "job"): the order
	    chosen for one is remembered for the others of its kind. */
	kind?: string;
}

const entryId = (entry: LogEntry) => entry.id;
const isSection = (entry: LogEntry) => entry.kind === "section";

/**
 * The log viewer: one line per entry with its time and level, a panel beside
 * the list for the entry you pick, filters, and a tail that pauses when you
 * scroll away from it.
 */
export function LogViewer({
	source,
	follow = false,
	status = "live",
	empty,
	className,
	toolbar = true,
	toolbarStart,
	toolbarEnd,
	urlState = false,
	showTimestamps = true,
	fileName,
	analyze,
	resetKey,
	kind = analyze === "build" ? "deployment" : "logs",
}: Props) {
	const { buffer, version } = source;
	const [search, setSearch] = useState(() => (urlState ? readParam("q") : ""));
	const deferredSearch = useDeferredValue(search);
	const [levels, setLevels] = useState<Set<LevelFilter>>(() =>
		urlState ? levelsFromUrl() : new Set(),
	);
	const [picked, setPicked] = useState<Set<string>>(new Set());
	const [wrap, setWrap] = useState(() => urlState && readParam("wrap") === "1");
	const [frozenId, setFrozenId] = useState<number | null>(null);
	const [levelsOpen, setLevelsOpen] = useState(false);
	const [sourcesOpen, setSourcesOpen] = useState(false);

	const all = buffer.entries;
	const shown = useMemo(
		() => (frozenId === null ? all.length : countThrough(all, frozenId)),
		[all, version, frozenId],
	);
	// A column and a filter for the source only when there is more than one:
	// a single file or container would repeat its name on every row.
	const sourceCount = buffer.sources.length;
	const labels = useMemo(
		() => (sourceCount > 1 ? sourceLabels(buffer.sources) : null),
		[buffer, sourceCount],
	);
	const sources = useMemo(() => {
		if (!labels) return new Set<string>();
		return new Set([...picked].filter((value) => labels.has(value)));
	}, [labels, picked]);
	const filtering =
		levels.size > 0 || sources.size > 0 || deferredSearch.trim() !== "";
	const view = useMemo(() => {
		const base = shown === all.length ? all : all.slice(0, shown);
		return filtering
			? filterEntries(base, { levels, sources, search: deferredSearch })
			: base;
	}, [all, version, shown, filtering, levels, sources, deferredSearch]);
	const pattern = useMemo(() => {
		const single = searchPattern(deferredSearch);
		return single ? new RegExp(single.source, "gi") : null;
	}, [deferredSearch]);
	const counts = useMemo(() => {
		const byLevel: Record<LevelFilter, number> = {
			error: 0,
			warn: 0,
			info: 0,
			debug: 0,
			other: 0,
		};
		const bySource = new Map<string, number>();
		if (!levelsOpen && !sourcesOpen) return { byLevel, bySource };
		for (let index = 0; index < shown; index++) {
			const entry = all[index] as LogEntry;
			if (entry.kind !== "entry") continue;
			byLevel[levelBucket(entry.level)]++;
			if (entry.source !== null) {
				bySource.set(entry.source, (bySource.get(entry.source) ?? 0) + 1);
			}
		}
		return { byLevel, bySource };
	}, [all, version, shown, levelsOpen, sourcesOpen]);
	const timed = useMemo(() => hasTimestamps(all), [all, version]);
	const showTime = showTimestamps && timed;
	const columns = useMemo(
		() => logColumns({ showTime, sources: labels }),
		[showTime, labels],
	);

	useEffect(() => {
		if (!urlState) return;
		writeParams({
			q: deferredSearch.trim() || null,
			levels: levels.size > 0 ? [...levels].join(",") : null,
			wrap: wrap ? "1" : null,
			errors: null,
		});
	}, [urlState, deferredSearch, levels, wrap]);

	useEffect(() => {
		setFrozenId(null);
		setPicked(new Set());
	}, [resetKey]);

	const onPausedChange = useCallback(
		(paused: boolean) => setFrozenId(paused ? buffer.lastId : null),
		[buffer],
	);
	// A cleared or trimmed buffer can drop the entry that is open.
	const isGone = useCallback(
		(entry: LogEntry) => {
			const first = buffer.entries[0];
			return !first || entry.id < first.id || entry.id > buffer.lastId;
		},
		[buffer],
	);
	const text = useCallback(
		() => entriesText(view, { timestamps: showTimestamps }),
		[view, showTimestamps],
	);
	const detail = useCallback(
		(entry: LogEntry, controls: DetailControls) => (
			<LogDetail
				entry={entry}
				sourceLabel={
					entry.source ? (labels?.get(entry.source) ?? undefined) : undefined
				}
				onFilter={setSearch}
				{...controls}
			/>
		),
		[labels],
	);
	const clearFilters = () => {
		setSearch("");
		setLevels(new Set());
		setPicked(new Set());
	};

	const activeLevels = LEVEL_OPTIONS.filter((option) =>
		levels.has(option.value),
	);
	const toggle = <V,>(set: Set<V>, value: V, on: boolean) => {
		const next = new Set(set);
		if (on) next.add(value);
		else next.delete(value);
		return next;
	};

	return (
		<ViewerShell
			label="Log lines"
			kind={kind}
			rows={view}
			version={version}
			rowId={entryId}
			rowStamp={entryStamp}
			rowTone={entryTone}
			divider={sectionRow}
			isDivider={isSection}
			isGone={isGone}
			columns={columns}
			detail={detail}
			toolbar={toolbar}
			search={search}
			onSearch={setSearch}
			searchLabel="Search logs"
			pattern={pattern}
			wrap={wrap}
			onWrap={setWrap}
			text={text}
			rowText={entryText}
			fileName={() => `${fileName?.() || "logs"}.log.txt`}
			copyLabel="Copy logs"
			follow={follow}
			status={status}
			pending={all.length - shown}
			onPausedChange={onPausedChange}
			className={className}
			resetKey={resetKey}
			summary={
				all.length === 0
					? null
					: filtering
						? `${view.length.toLocaleString()} of ${shown.toLocaleString()}`
						: `${shown.toLocaleString()} ${shown === 1 ? "line" : "lines"}`
			}
			filters={
				<>
					<DropdownMenu open={levelsOpen} onOpenChange={setLevelsOpen}>
						<DropdownMenuTrigger
							render={
								<Button
									variant="outline"
									size="sm"
									className="h-8 gap-1.5"
									aria-label="Filter by level"
								>
									<ListFilterIcon className="text-muted-foreground" />
									{activeLevels.length === 0
										? "All levels"
										: activeLevels.length <= 2
											? activeLevels.map((option) => option.label).join(", ")
											: `${activeLevels.length} levels`}
									<ChevronDownIcon className="size-3.5 text-muted-foreground" />
								</Button>
							}
						/>
						<DropdownMenuContent align="start" className="w-52">
							<DropdownMenuGroup>
								<DropdownMenuLabel>Show only</DropdownMenuLabel>
								{LEVEL_OPTIONS.map((option) => (
									<DropdownMenuCheckboxItem
										key={option.value}
										closeOnClick={false}
										checked={levels.has(option.value)}
										onCheckedChange={(checked) =>
											setLevels((current) =>
												toggle(current, option.value, checked),
											)
										}
									>
										<span
											className={cn(
												"size-1.5 shrink-0 rounded-full",
												option.dot,
											)}
										/>
										{option.label}
										<span className="ml-auto pl-3 text-muted-foreground text-xs tabular-nums">
											{counts.byLevel[option.value].toLocaleString()}
										</span>
									</DropdownMenuCheckboxItem>
								))}
							</DropdownMenuGroup>
							{levels.size > 0 ? (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuItem onClick={() => setLevels(new Set())}>
										<XIcon />
										Show all levels
									</DropdownMenuItem>
								</>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
					{labels ? (
						<DropdownMenu open={sourcesOpen} onOpenChange={setSourcesOpen}>
							<DropdownMenuTrigger
								render={
									<Button
										variant="outline"
										size="sm"
										className="h-8 max-w-64 gap-1.5"
										aria-label="Filter by source"
									>
										<FilesIcon className="text-muted-foreground" />
										<span className="truncate">
											{sources.size === 0
												? "All sources"
												: sources.size === 1
													? labels.get([...sources][0] ?? "")
													: `${sources.size} sources`}
										</span>
										<ChevronDownIcon className="size-3.5 text-muted-foreground" />
									</Button>
								}
							/>
							<DropdownMenuContent
								align="start"
								className="max-h-80 w-auto min-w-64 max-w-[28rem] overflow-y-auto"
							>
								<DropdownMenuGroup>
									<DropdownMenuLabel>Show only</DropdownMenuLabel>
									{[...labels].map(([value, label]) => {
										const Icon = value.includes("/") ? FileTextIcon : BoxIcon;
										return (
											<DropdownMenuCheckboxItem
												key={value}
												closeOnClick={false}
												checked={sources.has(value)}
												title={value}
												onCheckedChange={(checked) =>
													setPicked(toggle(sources, value, checked))
												}
											>
												<Icon className="text-muted-foreground" />
												<span className="min-w-0 truncate font-mono text-[13px]">
													{label}
												</span>
												<span className="ml-auto pl-3 text-muted-foreground text-xs tabular-nums">
													{(counts.bySource.get(value) ?? 0).toLocaleString()}
												</span>
											</DropdownMenuCheckboxItem>
										);
									})}
								</DropdownMenuGroup>
								{sources.size > 0 ? (
									<>
										<DropdownMenuSeparator />
										<DropdownMenuItem onClick={() => setPicked(new Set())}>
											<XIcon />
											Show all sources
										</DropdownMenuItem>
									</>
								) : null}
							</DropdownMenuContent>
						</DropdownMenu>
					) : null}
					{toolbarStart}
				</>
			}
			actions={toolbarEnd}
			after={analyze ? <AnalyzeLogs logs={view} context={analyze} /> : null}
			empty={
				all.length > 0 && filtering ? (
					<>
						No lines match these filters.
						<Button variant="outline" size="sm" onClick={clearFilters}>
							Clear filters
						</Button>
					</>
				) : (
					empty
				)
			}
		/>
	);
}

// Build output often carries no timestamps; an empty time column would only
// indent every line. Checked from the newest lines, which is where it settles.
function hasTimestamps(entries: readonly LogEntry[]) {
	for (
		let i = entries.length - 1, seen = 0;
		i >= 0 && seen < 200;
		i--, seen++
	) {
		if (entries[i]?.timestamp) return true;
	}
	return false;
}
