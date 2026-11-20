"use client";

import copy from "copy-to-clipboard";
import {
	Check,
	ChevronDownIcon,
	Copy,
	Download as DownloadIcon,
	Loader2,
	Pause,
	Play,
	SearchIcon,
	WrapTextIcon,
} from "lucide-react";
import React, { useEffect, useRef } from "react";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { type LiveRequest, useLiveSession } from "@/lib/live";
import { cn } from "@/lib/utils";
import { AnalyzeLogs } from "./analyze-logs";
import { LineCountFilter } from "./line-count-filter";
import {
	SINCE_OPTIONS,
	SinceLogsFilter,
	type TimeFilter,
} from "./since-logs-filter";
import { StatusLogsFilter } from "./status-logs-filter";
import { useHostScope } from "./use-live-scope";
import { getLogType, type LogLine, parseLogs } from "./utils";
import { VirtualLogList } from "./virtual-log-list";

interface Props {
	containerId: string;
	serverId?: string | null;
	runType: "swarm" | "native";
	serviceId?: string;
	// Height and surface of the log list (a full page passes its own).
	listClassName?: string;
	// Controls placed first in the toolbar (a full page puts its container
	// picker here, so filters and actions share one row).
	toolbarStart?: React.ReactNode;
	// "page": the full-page log view (search with match count, Since menu,
	// the caller's container picker, Errors only, following state, wrap,
	// download; filters kept in the URL). Other callers keep the default.
	layout?: "default" | "page";
}

// Sentinel the container-picker views fall back to before a real container
// is selected/auto-selected — querying logs for it just surfaces Docker's
// raw "No such container: select-a-container" daemon error.
const PLACEHOLDER_CONTAINER_ID = "select-a-container";

const SINCE_VALUES = SINCE_OPTIONS.map((option) => option.value);

function readParam(name: string): string {
	if (typeof window === "undefined") return "";
	return new URLSearchParams(window.location.search).get(name) ?? "";
}

/** Replaces the given query params in place (null removes one). */
export function writeParams(values: Record<string, string | null>) {
	const url = new URL(window.location.href);
	for (const [key, value] of Object.entries(values)) {
		if (value === null) url.searchParams.delete(key);
		else url.searchParams.set(key, value);
	}
	if (url.href !== window.location.href) {
		window.history.replaceState(window.history.state, "", url);
	}
}

export const priorities = [
	{
		label: "Info",
		value: "info",
	},
	{
		label: "Success",
		value: "success",
	},
	{
		label: "Warning",
		value: "warning",
	},
	{
		label: "Debug",
		value: "debug",
	},
	{
		label: "Error",
		value: "error",
	},
];

export const DockerLogsId: React.FC<Props> = ({
	containerId,
	serverId,
	runType,
	serviceId: _serviceId,
	listClassName,
	toolbarStart,
	layout = "default",
}) => {
	const page = layout === "page";
	const hasContainer =
		!!containerId && containerId !== PLACEHOLDER_CONTAINER_ID;
	const scope = useHostScope(serverId);

	const [rawLogs, setRawLogs] = React.useState("");
	const [filteredLogs, setFilteredLogs] = React.useState<LogLine[]>([]);
	const [lines, setLines] = React.useState<number>(100);
	const [search, setSearch] = React.useState<string>(() =>
		page ? readParam("q") : "",
	);
	const [streamSearch, setStreamSearch] = React.useState<string>("");
	const [showTimestamp, setShowTimestamp] = React.useState(true);
	const [since, setSince] = React.useState<TimeFilter>(() => {
		const value = page ? readParam("since") : "";
		return SINCE_VALUES.includes(value as TimeFilter)
			? (value as TimeFilter)
			: "all";
	});
	const [typeFilter, setTypeFilter] = React.useState<string[]>(() =>
		page && readParam("errors") === "1" ? ["error"] : [],
	);
	const [wrap, setWrap] = React.useState(() => readParam("wrap") !== "0");
	const [isPaused, setIsPaused] = React.useState(false);
	const [messageBuffer, setMessageBuffer] = React.useState<string[]>([]);
	const isPausedRef = useRef(false);
	const [isLoading, setIsLoading] = React.useState(false);
	const [copied, setCopied] = React.useState(false);
	const linesRef = useRef(lines);
	linesRef.current = lines;

	const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
		setSearch(e.target.value || "");
	};

	// Every search opens a new stream, so wait until typing pauses.
	useEffect(() => {
		const timeout = setTimeout(() => setStreamSearch(search), 400);
		return () => clearTimeout(timeout);
	}, [search]);

	// The full page keeps its filters in the URL, so a view can be shared.
	const errorsOnly = typeFilter.length === 1 && typeFilter[0] === "error";
	useEffect(() => {
		if (!page) return;
		writeParams({
			q: streamSearch || null,
			since: since === "all" ? null : since,
			errors: errorsOnly ? "1" : null,
			wrap: wrap ? null : "0",
		});
	}, [page, streamSearch, since, errorsOnly, wrap]);

	const handleLines = (lines: number) => {
		setRawLogs("");
		setFilteredLogs([]);
		setMessageBuffer([]);
		setLines(lines);
	};

	const handleSince = (value: TimeFilter) => {
		setRawLogs("");
		setFilteredLogs([]);
		setMessageBuffer([]);
		setSince(value);
	};

	const handlePauseResume = () => {
		if (isPaused) {
			// Resume: Apply all buffered messages
			if (messageBuffer.length > 0) {
				const bufferedContent = messageBuffer.join("");
				setRawLogs((prev) => {
					const updated = prev + bufferedContent;
					const splitLines = updated.split("\n");
					if (splitLines.length > lines) {
						return splitLines.slice(-lines).join("\n");
					}
					return updated;
				});
				setMessageBuffer([]);
			}
		}
		const newPausedState = !isPaused;
		setIsPaused(newPausedState);
		isPausedRef.current = newPausedState;
	};

	const request: LiveRequest | null = hasContainer
		? {
				kind: "containerLogs",
				scope,
				containerId,
				runType,
				tail: lines,
				since,
				search: streamSearch || undefined,
				timestamps: true,
			}
		: null;

	// The agent names the container (or swarm service) in its ready frame,
	// from the container config, for the download file name.
	const [containerName, setContainerName] = React.useState<string | null>(null);
	useEffect(() => setContainerName(null), [containerId, serverId]);
	const { status, error } = useLiveSession(request, (message) => {
		if (message.type === "ready" && typeof message.info?.name === "string") {
			setContainerName(message.info.name);
			return;
		}
		if (message.type !== "data") return;
		if (isPausedRef.current) {
			// When paused, buffer the messages instead of displaying them
			setMessageBuffer((prev) => [...prev, message.data]);
		} else {
			setRawLogs((prev) => {
				const updated = prev + message.data;
				const splitLines = updated.split("\n");
				if (splitLines.length > linesRef.current) {
					return splitLines.slice(-linesRef.current).join("\n");
				}
				return updated;
			});
		}
		setIsLoading(false);
	});

	useEffect(() => {
		if (!hasContainer) return;
		setIsLoading(true);
		setRawLogs("");
		setFilteredLogs([]);
		setMessageBuffer([]);
		// Reset pause state when container changes
		setIsPaused(false);
		isPausedRef.current = false;
	}, [hasContainer, containerId, serverId, lines, streamSearch, since]);

	// Wait 2 seconds for data before showing "No logs found".
	useEffect(() => {
		if (status === "open") {
			const timeout = setTimeout(() => setIsLoading(false), 2000);
			return () => clearTimeout(timeout);
		}
		if (status === "closed" || status === "error") setIsLoading(false);
	}, [status]);

	const handleDownload = () => {
		const logContent = filteredLogs
			.map(
				({ timestamp, message }: { timestamp: Date | null; message: string }) =>
					`${timestamp?.toISOString() || "No timestamp"} ${message}`,
			)
			.join("\n");

		const blob = new Blob([logContent], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		const appName = (containerName ?? containerId).replace("/", "") || "app";
		const isoDate = new Date().toISOString();
		a.href = url;
		a.download = `${appName}-${isoDate.slice(0, 10).replace(/-/g, "")}_${isoDate
			.slice(11, 19)
			.replace(/:/g, "")}.log.txt`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	};

	const handleCopy = async () => {
		const logContent = filteredLogs
			.map(
				({
					timestamp,
					message,
				}: {
					timestamp: Date | null;
					message: string;
				}) =>
					showTimestamp
						? `${timestamp?.toISOString() || "No timestamp"} ${message}`
						: message,
			)
			.join("\n");

		const success = copy(logContent);
		if (success) {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	};

	const handleFilter = (logs: LogLine[]) => {
		return logs.filter((log) => {
			const logType = getLogType(log.message).type;

			if (typeFilter.length === 0) {
				return true;
			}

			return typeFilter.includes(logType);
		});
	};

	// Sync isPausedRef with isPaused state
	useEffect(() => {
		isPausedRef.current = isPaused;
	}, [isPaused]);

	useEffect(() => {
		setRawLogs("");
		setFilteredLogs([]);
		setMessageBuffer([]);
	}, [containerId]);

	useEffect(() => {
		const logs = parseLogs(rawLogs);
		const filtered = handleFilter(logs);
		setFilteredLogs(filtered);
	}, [rawLogs, search, lines, since, typeFilter]);

	if (page) {
		const following = status === "open" && !isPaused;
		const sinceLabel =
			since === "all"
				? "Live"
				: (SINCE_OPTIONS.find((option) => option.value === since)?.label ??
					since);
		return (
			<div className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center gap-2 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:*:shrink-0">
					<div className="relative w-56 max-w-full">
						<SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<Input
							type="search"
							aria-label="Search logs"
							placeholder="Search logs"
							value={search}
							onChange={handleSearch}
							className="h-8 pr-20 pl-8 text-[13px] [&::-webkit-search-cancel-button]:hidden"
						/>
						{search && hasContainer && !isLoading ? (
							<span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground text-xs tabular-nums">
								{filteredLogs.length.toLocaleString()}{" "}
								{filteredLogs.length === 1 ? "match" : "matches"}
							</span>
						) : null}
					</div>
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button variant="outline" size="sm" className="h-8 gap-1.5">
									<span className="text-muted-foreground">Since</span>
									{sinceLabel}
									<ChevronDownIcon className="size-3.5 text-muted-foreground" />
								</Button>
							}
						/>
						<DropdownMenuContent align="start" className="w-52">
							<DropdownMenuGroup>
								<DropdownMenuLabel>Since</DropdownMenuLabel>
								<DropdownMenuRadioGroup
									value={since}
									onValueChange={(value) => handleSince(value as TimeFilter)}
								>
									{SINCE_OPTIONS.map((option) => (
										<DropdownMenuRadioItem
											key={option.value}
											value={option.value}
										>
											{option.value === "all" ? "Live" : option.label}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuGroup>
							<DropdownMenuSeparator />
							<DropdownMenuGroup>
								<DropdownMenuLabel>Lines kept</DropdownMenuLabel>
								<DropdownMenuRadioGroup
									value={String(lines)}
									onValueChange={(value) => handleLines(Number(value))}
								>
									{[100, 500, 1000, 5000, 10000].map((count) => (
										<DropdownMenuRadioItem key={count} value={String(count)}>
											{count.toLocaleString()}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuGroup>
							<DropdownMenuSeparator />
							<DropdownMenuCheckboxItem
								checked={showTimestamp}
								onCheckedChange={(checked) => setShowTimestamp(!!checked)}
							>
								Timestamps
							</DropdownMenuCheckboxItem>
							<DropdownMenuSeparator />
							<DropdownMenuGroup>
								<DropdownMenuLabel>Log type</DropdownMenuLabel>
								{priorities.map((priority) => (
									<DropdownMenuCheckboxItem
										key={priority.value}
										closeOnClick={false}
										checked={typeFilter.includes(priority.value)}
										onCheckedChange={(checked) =>
											setTypeFilter((current) =>
												checked
													? [...current, priority.value]
													: current.filter((value) => value !== priority.value),
											)
										}
									>
										{priority.label}
									</DropdownMenuCheckboxItem>
								))}
							</DropdownMenuGroup>
						</DropdownMenuContent>
					</DropdownMenu>
					{toolbarStart}
					<Button
						variant="outline"
						size="sm"
						aria-pressed={errorsOnly}
						onClick={() => setTypeFilter(errorsOnly ? [] : ["error"])}
						className={cn(
							"h-8",
							errorsOnly
								? "border-destructive/40 text-destructive"
								: "border-dashed text-muted-foreground",
						)}
					>
						Errors only
					</Button>
					<div className="ml-auto flex items-center gap-1">
						<span
							className={cn(
								"flex items-center gap-1.5 px-2 font-medium text-[13px]",
								following ? "text-success" : "text-muted-foreground",
							)}
						>
							<span
								className={cn(
									"size-1.5 rounded-full",
									following ? "bg-success" : "bg-muted-foreground",
								)}
							/>
							{!hasContainer
								? "Waiting"
								: isPaused
									? "Paused"
									: status === "open"
										? "Following"
										: status === "error"
											? "Disconnected"
											: "Connecting…"}
						</span>
						<Button
							variant="ghost"
							size="sm"
							className="h-8"
							onClick={handlePauseResume}
							disabled={!hasContainer}
						>
							{isPaused ? <Play /> : <Pause />}
							{isPaused ? "Resume" : "Pause"}
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-pressed={wrap}
							aria-label="Wrap long lines"
							onClick={() => setWrap((value) => !value)}
							title={wrap ? "Wrapping long lines" : "Long lines on one row"}
							className={cn(wrap ? "text-foreground" : "text-muted-foreground")}
						>
							<WrapTextIcon />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={handleCopy}
							disabled={filteredLogs.length === 0}
							aria-label="Copy logs"
							title="Copy logs"
						>
							{copied ? <Check /> : <Copy />}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="h-8"
							onClick={handleDownload}
							disabled={filteredLogs.length === 0}
						>
							<DownloadIcon />
							Download
						</Button>
						<AnalyzeLogs logs={filteredLogs} context="runtime" />
					</div>
				</div>
				<div className="relative">
					<VirtualLogList
						logs={filteredLogs}
						searchTerm={search}
						noTimestamp={!showTimestamp}
						variant="plain"
						wrap={wrap}
						follow={!isPaused}
						className={cn(
							// The bottom padding keeps the last line clear of the status chip.
							"px-6! pt-5! pb-12! dark:[color-scheme:dark]",
							listClassName ??
								"h-[60vh] rounded-xl border border-border bg-terminal text-terminal-foreground",
						)}
					>
						{isLoading ? (
							<div className="flex h-full items-center justify-center text-terminal-foreground/50">
								<Loader2 className="size-5 animate-spin" />
							</div>
						) : (
							<div className="flex h-full items-center justify-center px-8 text-center text-sm text-terminal-foreground/50">
								{hasContainer
									? (error ??
										(search || errorsOnly
											? "No lines match these filters."
											: "No logs yet."))
									: "Select a container above to view its logs. If none are listed, make sure the service is deployed and running."}
							</div>
						)}
					</VirtualLogList>
					{hasContainer ? (
						<span className="pointer-events-none absolute right-4 bottom-4 flex items-center gap-1.5 rounded-md border border-border bg-terminal-foreground/10 px-2.5 py-1 font-mono text-terminal-foreground/60 text-xs">
							<span
								className={cn(
									"size-1.5 rounded-full",
									following
										? "bg-success"
										: "border border-border bg-terminal-foreground/40",
								)}
							/>
							{isPaused
								? `paused${messageBuffer.length ? ` · ${messageBuffer.length} buffered` : ""}`
								: following
									? "live"
									: "offline"}{" "}
							· {filteredLogs.length.toLocaleString()} lines
						</span>
					) : null}
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="rounded-lg">
				<div className="space-y-4">
					<div
						className={cn(
							"flex flex-wrap justify-between items-start sm:items-center",
							toolbarStart ? "gap-2" : "gap-4",
						)}
					>
						<div
							className={cn(
								"flex flex-wrap max-sm:w-full max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:*:shrink-0",
								toolbarStart ? "items-center gap-2" : "gap-4",
							)}
						>
							{toolbarStart}
							<LineCountFilter value={lines} onValueChange={handleLines} />

							<SinceLogsFilter
								value={since}
								onValueChange={handleSince}
								showTimestamp={showTimestamp}
								onTimestampChange={setShowTimestamp}
							/>

							<StatusLogsFilter
								value={typeFilter}
								setValue={setTypeFilter}
								title="Log type"
								options={priorities}
							/>

							<Input
								type="search"
								placeholder="Search logs..."
								value={search}
								onChange={handleSearch}
								className="inline-flex h-9 text-sm placeholder-gray-400 w-40 sm:w-auto"
							/>
						</div>

						<div className="flex flex-wrap gap-2">
							<Button
								variant="outline"
								size="sm"
								className="h-9 sm:w-auto"
								onClick={handlePauseResume}
								aria-label={isPaused ? "Resume logs" : "Pause logs"}
								title={isPaused ? "Resume logs" : "Pause logs"}
							>
								{isPaused ? (
									<Play className="size-4" />
								) : (
									<Pause className="size-4" />
								)}
								<span className="hidden lg:ml-2 lg:inline">
									{isPaused ? "Resume" : "Pause"}
								</span>
							</Button>
							<Button
								variant="outline"
								size="sm"
								className="h-9 sm:w-auto"
								onClick={handleCopy}
								disabled={filteredLogs.length === 0}
								aria-label="Copy logs to clipboard"
								title="Copy logs to clipboard"
							>
								{copied ? (
									<Check className="size-4" />
								) : (
									<Copy className="size-4" />
								)}
								<span className="hidden lg:ml-2 lg:inline">
									{copied ? "Copied" : "Copy"}
								</span>
							</Button>
							<Button
								variant="outline"
								size="sm"
								className="h-9 sm:w-auto"
								onClick={handleDownload}
								disabled={filteredLogs.length === 0}
								aria-label="Download logs as text file"
								title="Download logs as text file"
							>
								<DownloadIcon className="size-4" />
								<span className="hidden lg:ml-2 lg:inline">Download logs</span>
							</Button>
							<AnalyzeLogs logs={filteredLogs} context="runtime" />
						</div>
					</div>
					{isPaused && (
						<AlertBlock type="warning" className="items-center">
							<div className="flex items-center gap-2">
								<Pause className="size-4" />
								<span>
									Logs paused
									{messageBuffer.length > 0 && (
										<span className="ml-1 font-medium">
											({messageBuffer.length} messages buffered)
										</span>
									)}
								</span>
							</div>
						</AlertBlock>
					)}
					<VirtualLogList
						logs={filteredLogs}
						searchTerm={search}
						noTimestamp={!showTimestamp}
						className={listClassName ?? "h-[50vh] sm:h-[720px] bg-terminal"}
					>
						{isLoading ? (
							<div className="flex justify-center items-center h-full text-muted-foreground">
								<Loader2 className="h-6 w-6 animate-spin" />
							</div>
						) : hasContainer ? (
							<div className="flex justify-center items-center h-full text-muted-foreground">
								{error ?? "No logs found"}
							</div>
						) : (
							<div className="flex justify-center items-center h-full text-center text-sm text-muted-foreground px-8">
								Select a container above to view its logs. If none are listed,
								make sure the service is deployed and running.
							</div>
						)}
					</VirtualLogList>
				</div>
			</div>
		</div>
	);
};
