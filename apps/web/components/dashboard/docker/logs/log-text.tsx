"use client";

import { FancyAnsi } from "fancy-ansi";
import { memo, type ReactNode } from "react";

const fancyAnsi = new FancyAnsi();

const dateFormat = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "2-digit",
});
const timeFormat = new Intl.DateTimeFormat(undefined, {
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23",
});
const fullFormat = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "long",
});

export const formatClock = (date: Date) => timeFormat.format(date);
export const formatDay = (date: Date) => dateFormat.format(date);
export const formatMillis = (date: Date) =>
	String(date.getMilliseconds()).padStart(3, "0");
export const formatFull = (date: Date) => fullFormat.format(date);
/** The local date and time with its milliseconds, for a detail panel. */
export const formatLocal = (date: Date) =>
	formatFull(date).replace(/(\d{1,2}:\d{2}:\d{2})/, `$1.${formatMillis(date)}`);

/** The slot every viewer gives a row's time: day, clock, faint milliseconds. */
export const TIME_SLOT =
	"w-16 shrink-0 select-none whitespace-nowrap tabular-nums sm:w-[9.25rem] sm:@max-2xl/viewer:w-[5.875rem]";

export function TimeCell({ time }: { time: Date | null }) {
	if (!time) return null;
	return (
		<>
			<span className="max-sm:hidden @max-2xl/viewer:hidden">
				{formatDay(time)}{" "}
			</span>
			{formatClock(time)}
			<span className="text-terminal-foreground/30 max-sm:hidden">
				.{formatMillis(time)}
			</span>
		</>
	);
}

export const timeTitle = (time: Date | null) =>
	time ? `${formatFull(time)}\n${time.toISOString()} UTC` : undefined;

const MARK = "rounded-[2px] bg-warning/35 text-inherit";

/** `text` with every match of `pattern` (a global expression) marked. */
export function highlight(text: string, pattern: RegExp | null): ReactNode {
	if (!pattern || !text) return text;
	const parts: ReactNode[] = [];
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		if (match[0] === "") continue;
		if (match.index > last) parts.push(text.slice(last, match.index));
		parts.push(
			<mark key={match.index} className={MARK}>
				{match[0]}
			</mark>,
		);
		last = match.index + match[0].length;
	}
	if (parts.length === 0) return text;
	if (last < text.length) parts.push(text.slice(last));
	return parts;
}

const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
};
const unescapeHtml = (text: string) =>
	text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? "");
const escapeHtml = (text: string) =>
	text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

// Marks go into the text between the colour spans only, so a search for
// "span" or "color" never rewrites the markup itself.
function ansiHtml(raw: string, pattern: RegExp | null): string {
	const html = fancyAnsi.toHtml(raw);
	if (!pattern) return html;
	return html
		.split(/(<[^>]+>)/)
		.map((part) => {
			if (part.startsWith("<")) return part;
			const text = unescapeHtml(part);
			let out = "";
			let last = 0;
			for (const match of text.matchAll(pattern)) {
				if (match[0] === "") continue;
				out += escapeHtml(text.slice(last, match.index));
				out += `<mark class="${MARK}">${escapeHtml(match[0])}</mark>`;
				last = match.index + match[0].length;
			}
			return out + escapeHtml(text.slice(last));
		})
		.join("");
}

/** Log text with the colours the program printed and search matches marked. */
export const LogText = memo(function LogText({
	raw,
	pattern,
}: {
	raw: string;
	pattern: RegExp | null;
}) {
	if (!raw.includes("\x1b")) return <>{highlight(raw, pattern)}</>;
	return <span dangerouslySetInnerHTML={{ __html: ansiHtml(raw, pattern) }} />;
});

// One row, one line: a value that spans lines is shown run together.
export const oneLine = (value: string, length: number) => {
	const flat = value.includes("\n") ? value.replace(/\s*\n\s*/g, " ↵ ") : value;
	return flat.length > length ? `${flat.slice(0, length)}…` : flat;
};
