"use client";

import { FancyAnsi } from "fancy-ansi";
import escapeRegExp from "lodash/escapeRegExp";
import { Badge } from "@/components/ui/badge";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getLogType, type LogLine } from "./utils";

interface LogLineProps {
	log: LogLine;
	noTimestamp?: boolean;
	searchTerm?: string;
	// "plain": the full-page log view's rows: time, message coloured by
	// level, no badge or tint. Default keeps the classic row.
	variant?: "classic" | "plain";
	// false keeps each line on one row (the list scrolls sideways).
	wrap?: boolean;
}

const fancyAnsi = new FancyAnsi();

export function TerminalLine({
	log,
	noTimestamp,
	searchTerm,
	variant: lineVariant = "classic",
	wrap = true,
}: LogLineProps) {
	const { timestamp, message, rawTimestamp } = log;
	const { type, variant, color } = getLogType(message);

	const formattedTime = timestamp
		? timestamp.toLocaleString([], {
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				year: "2-digit",
				second: "2-digit",
			})
		: "--- No time found ---";

	const highlightMessage = (text: string, term: string) => {
		if (!term) {
			return (
				<span
					className="transition-colors"
					dangerouslySetInnerHTML={{
						__html: fancyAnsi.toHtml(text),
					}}
				/>
			);
		}

		const htmlContent = fancyAnsi.toHtml(text);
		const searchRegex = new RegExp(`(${escapeRegExp(term)})`, "gi");

		const modifiedContent = htmlContent.replace(searchRegex, (match) =>
			lineVariant === "plain"
				? `<span class="underline decoration-warning underline-offset-2 text-warning">${match}</span>`
				: `<span class="bg-orange-200/80 dark:bg-orange-900/80 font-bold">${match}</span>`,
		);

		return (
			<span
				className="transition-colors"
				dangerouslySetInnerHTML={{ __html: modifiedContent }}
			/>
		);
	};

	const tooltip = (color: string, timestamp: string | null) => {
		const square = (
			<div
				className={cn("w-2 min-h-4 h-full flex-shrink-0 rounded-[3px]", color)}
			/>
		);
		return timestamp ? (
			<TooltipProvider delay={0}>
				<Tooltip disableHoverablePopup>
					<TooltipTrigger render={square as React.ReactElement} />
					<TooltipContent
						sideOffset={5}
						className="bg-popover border-border z-99999"
					>
						<p className="text text-xs text-muted-foreground break-all max-w-md">
							<pre>{timestamp}</pre>
						</p>
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		) : (
			square
		);
	};

	if (lineVariant === "plain") {
		const time = timestamp
			? `${timestamp.toLocaleTimeString([], {
					hour12: false,
					hour: "2-digit",
					minute: "2-digit",
					second: "2-digit",
				})}.${String(timestamp.getMilliseconds()).padStart(3, "0")}`
			: "";
		return (
			<div
				className={cn(
					"flex gap-4 py-px font-mono text-[13px] leading-6",
					wrap ? "" : "w-max min-w-full",
				)}
			>
				{!noTimestamp ? (
					<span className="w-24 shrink-0 select-none text-terminal-foreground/35 tabular-nums">
						{time}
					</span>
				) : null}
				<span
					className={cn(
						"min-w-0",
						wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
						type === "error"
							? "text-danger"
							: type === "warning"
								? "text-warning"
								: "text-terminal-foreground/90",
					)}
				>
					{highlightMessage(message, searchTerm || "")}
				</span>
			</div>
		);
	}

	return (
		<div
			className={cn(
				"font-mono text-xs flex flex-col sm:flex-row gap-1 sm:gap-3 py-2 sm:py-0.5 group",
				type === "error"
					? "bg-red-500/10 hover:bg-red-500/15"
					: type === "warning"
						? "bg-yellow-500/10 hover:bg-yellow-500/15"
						: type === "debug"
							? "bg-orange-500/10 hover:bg-orange-500/15"
							: "hover:bg-gray-200/50 dark:hover:bg-gray-800/50",
			)}
		>
			{" "}
			<div className="flex items-start gap-x-2">
				{/* Icon to expand the log item maybe implement a collapsible later */}
				{/* <Square className="size-4 text-muted-foreground opacity-0 group-hover/logitem:opacity-100 transition-opacity" /> */}
				{tooltip(color, rawTimestamp)}
				{!noTimestamp && (
					<span className="select-none pl-2 text-muted-foreground w-auto sm:w-40 flex-shrink-0">
						{formattedTime}
					</span>
				)}

				<Badge
					variant={variant}
					className="w-14 justify-center text-[10px] px-1 py-0"
				>
					{type}
				</Badge>
			</div>
			<span className="dark:text-gray-200 font-mono text-foreground whitespace-pre-wrap break-all">
				{highlightMessage(message, searchTerm || "")}
			</span>
		</div>
	);
}
