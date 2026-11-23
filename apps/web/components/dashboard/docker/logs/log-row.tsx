"use client";

import type { ReactNode } from "react";
import { type LogEntry, type LogLevel, rowFields } from "@/lib/log-entries";
import { cn } from "@/lib/utils";
import {
	highlight,
	LogText,
	oneLine,
	TIME_SLOT,
	TimeCell,
	timeTitle,
} from "./log-text";
import { ROW_HEIGHT, type RowTone, type ViewerColumn } from "./viewer-list";

const LEVEL_TEXT: Record<LogLevel, string> = {
	error: "text-destructive",
	warn: "text-warning",
	info: "text-terminal-foreground/60",
	debug: "text-terminal-foreground/40",
	trace: "text-terminal-foreground/40",
};

export const levelTextClass = (level: LogLevel | null) =>
	level ? LEVEL_TEXT[level] : "text-terminal-foreground/40";

export const entryTone = (entry: LogEntry): RowTone =>
	entry.level === "error" || entry.level === "warn" ? entry.level : null;

/** A row is updated in place as lines attach to it: this changes when it is. */
export const entryStamp = (entry: LogEntry) =>
	`${entry.level}:${entry.attached.length}:${entry.message.length}`;

// A row is for scanning: a few short fields, the rest one click away.
const ROW_FIELDS = 4;
const WRAPPED_FIELDS = 12;
const ROW_VALUE_LENGTH = 48;
const ROW_MESSAGE_LENGTH = 1200;
/** Widest a source name gets before it is cut, in characters. */
const SOURCE_WIDTH = 30;

/** A build step's title: a quiet line across the list, not an entry. */
export function sectionRow(
	entry: LogEntry,
	pattern: RegExp | null,
): ReactNode | null {
	if (entry.kind !== "section") return null;
	return (
		<div
			className="flex items-center gap-3 px-4 text-terminal-foreground/50"
			style={{ minHeight: ROW_HEIGHT }}
		>
			<span className="min-w-0 truncate font-medium font-sans text-xs">
				{highlight(entry.message, pattern)}
			</span>
			<span className="h-px min-w-6 flex-1 bg-border" />
		</div>
	);
}

function Message({
	entry,
	wrap,
	pattern,
}: {
	entry: LogEntry;
	wrap: boolean;
	pattern: RegExp | null;
}) {
	const fields = rowFields(entry, wrap ? WRAPPED_FIELDS : ROW_FIELDS);
	return (
		<>
			<LogText
				raw={wrap ? entry.message : oneLine(entry.message, ROW_MESSAGE_LENGTH)}
				pattern={pattern}
			/>
			{entry.logger ? (
				<span className="text-terminal-foreground/45">
					{"  "}
					{highlight(entry.logger, pattern)}
				</span>
			) : null}
			{fields.map((field) => (
				<span key={field.key} className="text-terminal-foreground/55">
					{"  "}
					<span className="text-terminal-foreground/40">{field.key}=</span>
					{highlight(
						wrap ? field.value : oneLine(field.value, ROW_VALUE_LENGTH),
						pattern,
					)}
				</span>
			))}
			{wrap && entry.attached.length > 0 ? (
				<span className="block text-terminal-foreground/60">
					{entry.attached.map((line, index) => (
						<span key={index} className="block">
							<LogText raw={line} pattern={pattern} />
						</span>
					))}
				</span>
			) : null}
		</>
	);
}

/**
 * The columns of a log: time, level, where it came from (only when the
 * output has more than one source), then the message.
 */
export function logColumns({
	showTime,
	sources,
}: {
	showTime: boolean;
	/** Short names by source, when there are several. */
	sources: ReadonlyMap<string, string> | null;
}): ViewerColumn<LogEntry>[] {
	const columns: ViewerColumn<LogEntry>[] = [];
	if (showTime) {
		columns.push({
			id: "time",
			header: "Time",
			className: TIME_SLOT,
			cellClassName: "text-terminal-foreground/50",
			title: (entry) => timeTitle(entry.timestamp),
			cell: (entry) => <TimeCell time={entry.timestamp} />,
		});
	}
	columns.push({
		id: "level",
		header: "Level",
		className: "w-10 shrink-0 select-none",
		cellClassName: (entry) => levelTextClass(entry.level),
		cell: (entry) => entry.level ?? "",
	});
	if (sources) {
		const longest = Math.max(0, ...[...sources.values()].map((s) => s.length));
		columns.push({
			id: "source",
			// Sized in the row's own type, so the heading lines up with it.
			header: <span className="font-sans text-xs">Source</span>,
			className:
				"shrink-0 truncate font-mono text-[13px] max-sm:hidden @max-3xl/viewer:max-w-[18ch]",
			style: { width: `${Math.min(Math.max(longest, 6), SOURCE_WIDTH)}ch` },
			cellClassName: "text-terminal-foreground/50",
			title: (entry) => entry.source ?? undefined,
			cell: (entry) =>
				entry.source ? (sources.get(entry.source) ?? entry.source) : "",
		});
	}
	columns.push(
		{
			id: "message",
			header: "Message",
			grow: true,
			className: "min-w-0 flex-1",
			cellClassName: (entry, { wrap }) =>
				cn(
					wrap
						? "whitespace-pre-wrap [overflow-wrap:anywhere]"
						: "truncate whitespace-pre",
					entry.level === "error"
						? "text-destructive"
						: "text-terminal-foreground/90",
				),
			cell: (entry, { wrap, pattern }) => (
				<Message entry={entry} wrap={wrap} pattern={pattern} />
			),
		},
		{
			id: "attached",
			header: null,
			optional: true,
			className:
				"shrink-0 select-none font-sans text-terminal-foreground/50 text-xs",
			cell: (entry, { wrap }) =>
				!wrap && entry.attached.length > 0
					? `+${entry.attached.length} ${entry.attached.length === 1 ? "line" : "lines"}`
					: null,
		},
	);
	return columns;
}
