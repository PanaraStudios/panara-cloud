"use client";

import { useMemo } from "react";
import {
	differingAppTimestamp,
	entryText,
	findJson,
	type LogEntry,
	stripAnsi,
} from "@/lib/log-entries";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import {
	Block,
	DetailPanel,
	Fact,
	Facts,
	FieldList,
	PRE,
} from "./detail-panel";
import { JsonTree } from "./json-tree";
import { levelTextClass } from "./log-row";
import { formatLocal, LogText } from "./log-text";
import type { DetailControls } from "./viewer-shell";

const STACK_LINE =
	/^\s+at\s|^\s+File "|^goroutine \d+|^Caused by: |^\t.+\.go:\d+/;

/** What a logger printed around a text line's message, kept with the facts. */
const PREFIX_FIELDS = ["pid", "thread", "caller"];

interface Props extends DetailControls {
	entry: LogEntry;
	/** Short name of the entry's source, when the list shows one. */
	sourceLabel?: string;
	/** Puts a value in the search box. */
	onFilter: (value: string) => void;
}

/** The whole of one entry, beside the list. */
export function LogDetail({
	entry,
	sourceLabel,
	pattern,
	onFilter,
	...controls
}: Props) {
	const time = entry.timestamp;
	const message = stripAnsi(entry.message);
	const attached = entry.attached.map(stripAnsi).join("\n");
	const isStack = entry.attached.some((line) => STACK_LINE.test(line));
	// Read when the entry is opened: a list of thousands never pays for it.
	const json = useMemo(() => findJson(entry.text), [entry]);
	const formatted = useMemo(
		() => (json ? JSON.stringify(json.value, null, 2) : ""),
		[json],
	);
	const printed = differingAppTimestamp(entry);
	// The tree shows what the JSON holds; a list of the same would repeat it.
	const fields =
		!json || entry.format === "text"
			? entry.fields
			: entry.format === "mixed"
				? entry.fields.filter((field) => PREFIX_FIELDS.includes(field.key))
				: [];
	return (
		<DetailPanel
			label="Log entry"
			noun="entry"
			copyText={entryText(entry)}
			title={
				<>
					{entry.level ? (
						<span
							className={cn(
								"font-mono text-[13px]",
								levelTextClass(entry.level),
							)}
						>
							{entry.level}
						</span>
					) : null}
					<span className="min-w-0 truncate text-[13px] text-terminal-foreground/60">
						{time ? relativeTime(time.getTime()) : "Log entry"}
					</span>
				</>
			}
			{...controls}
		>
			<Block title="Message" copyText={message}>
				<pre className={cn(PRE, entry.level === "error" && "text-destructive")}>
					<LogText raw={entry.message} pattern={pattern} />
				</pre>
				{entry.logger ? (
					<p className="break-all font-mono text-[13px] text-terminal-foreground/50">
						{entry.logger}
					</p>
				) : null}
			</Block>
			{entry.attached.length > 0 ? (
				<Block
					title={isStack ? "Stack trace" : "Attached lines"}
					count={entry.attached.length}
					copyText={attached}
				>
					<pre className="custom-logs-scrollbar overflow-x-auto whitespace-pre pb-1 font-mono text-[13px] text-terminal-foreground/75 leading-5 [tab-size:4]">
						{entry.attached.map((line, index) => (
							<span key={index} className="block">
								<LogText raw={line} pattern={pattern} />
							</span>
						))}
					</pre>
				</Block>
			) : null}
			{json ? (
				<Block
					title="JSON"
					copyText={formatted}
					copyLabel="Copy formatted JSON"
				>
					{/* Keyed by entry: what was folded belongs to the entry it was folded in. */}
					<JsonTree
						key={entry.id}
						value={json.value}
						pattern={pattern}
						onFilter={onFilter}
					/>
					{json.after ? (
						<pre className={cn(PRE, "text-terminal-foreground/60")}>
							{json.after}
						</pre>
					) : null}
				</Block>
			) : null}
			{fields.length > 0 ? (
				<Block title="Fields" count={fields.length}>
					<FieldList fields={fields} pattern={pattern} onFilter={onFilter} />
				</Block>
			) : null}
			<Block title="Details">
				<Facts>
					{time ? (
						<>
							<Fact label="Time">{formatLocal(time)}</Fact>
							<Fact label="UTC">{time.toISOString()}</Fact>
						</>
					) : (
						<Fact label="Time" className="font-sans text-muted-foreground">
							Not recorded
						</Fact>
					)}
					{printed ? <Fact label="Printed time">{printed}</Fact> : null}
					<Fact label="Level" className={levelTextClass(entry.level)}>
						{entry.level ?? "none"}
					</Fact>
					{entry.source ? (
						<Fact label={entry.file ? "File" : "Source"}>
							{sourceLabel && sourceLabel !== entry.source ? (
								<span className="block text-terminal-foreground/60">
									{sourceLabel}
								</span>
							) : null}
							{entry.source}
						</Fact>
					) : null}
					{entry.stream ? <Fact label="Stream">{entry.stream}</Fact> : null}
				</Facts>
			</Block>
			{entry.text !== message ? (
				<Block title="Raw" copyText={entry.text} copyLabel="Copy raw line">
					<pre className={cn(PRE, "text-terminal-foreground/70")}>
						{entry.text}
					</pre>
				</Block>
			) : null}
		</DetailPanel>
	);
}
