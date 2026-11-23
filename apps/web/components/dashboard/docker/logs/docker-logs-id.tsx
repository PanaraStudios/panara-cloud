"use client";

import { ChevronDownIcon, Loader2 } from "lucide-react";
import React, { useEffect } from "react";
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
import { type LiveRequest, useLiveSession } from "@/lib/live";
import { LogViewer } from "./log-viewer";
import { SINCE_OPTIONS, type TimeFilter } from "./since-options";
import { readParam, writeParams } from "./url-params";
import { useServiceOrHostScope } from "./use-live-scope";
import { useLogStream } from "./use-log-buffer";

interface Props {
	containerId: string;
	serverId?: string | null;
	runType: "swarm" | "native";
	/** The service whose logs these are: a member granted only that service
	    reads them through it. */
	serviceId?: string;
	serviceKind?: "application" | "compose" | "database";
	// Height of the viewer (a full page passes its own).
	listClassName?: string;
	// Controls placed after the filters (a full page puts its container
	// picker here, so filters and actions share one row).
	toolbarStart?: React.ReactNode;
	// A full-page log view keeps its filters in the URL, so a view can be shared.
	urlState?: boolean;
}

// Sentinel the container-picker views fall back to before a real container
// is selected/auto-selected — querying logs for it just surfaces Docker's
// raw "No such container: select-a-container" daemon error.
const PLACEHOLDER_CONTAINER_ID = "select-a-container";

const SINCE_VALUES = SINCE_OPTIONS.map((option) => option.value);
const HISTORY = [100, 500, 1000, 5000, 10000];
const DEFAULT_HISTORY = 1000;

export const DockerLogsId: React.FC<Props> = ({
	containerId,
	serverId,
	runType,
	serviceId,
	serviceKind,
	listClassName,
	toolbarStart,
	urlState = false,
}) => {
	const hasContainer =
		!!containerId && containerId !== PLACEHOLDER_CONTAINER_ID;
	const scope = useServiceOrHostScope(
		serverId,
		serviceId && serviceKind ? { id: serviceId, kind: serviceKind } : undefined,
	);
	const stream = useLogStream();

	const [lines, setLines] = React.useState<number>(DEFAULT_HISTORY);
	const [showTimestamp, setShowTimestamp] = React.useState(true);
	const [since, setSince] = React.useState<TimeFilter>(() => {
		const value = urlState ? readParam("since") : "";
		return SINCE_VALUES.includes(value as TimeFilter)
			? (value as TimeFilter)
			: "all";
	});
	const [isLoading, setIsLoading] = React.useState(false);

	useEffect(() => {
		if (urlState) writeParams({ since: since === "all" ? null : since });
	}, [urlState, since]);

	const request: LiveRequest | null = hasContainer
		? {
				kind: "containerLogs",
				scope,
				containerId,
				runType,
				tail: lines,
				since,
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
		stream.push(message.data);
		setIsLoading(false);
	});

	const resetKey = `${serverId ?? ""}:${containerId}:${lines}:${since}`;
	useEffect(() => {
		stream.clear();
		setIsLoading(hasContainer);
	}, [resetKey, hasContainer]);

	// Wait 2 seconds for data before showing "No logs yet".
	useEffect(() => {
		if (status === "open") {
			const timeout = setTimeout(() => setIsLoading(false), 2000);
			return () => clearTimeout(timeout);
		}
		if (status === "closed" || status === "error") setIsLoading(false);
	}, [status]);

	const sinceLabel =
		since === "all"
			? "Live"
			: (SINCE_OPTIONS.find((option) => option.value === since)?.label ??
				since);

	return (
		<LogViewer
			source={stream}
			follow={hasContainer}
			status={
				status === "open"
					? "live"
					: status === "connecting" || status === "idle"
						? "connecting"
						: "offline"
			}
			resetKey={resetKey}
			urlState={urlState}
			showTimestamps={showTimestamp}
			className={listClassName}
			analyze="runtime"
			kind="container"
			fileName={() => {
				const name = (containerName ?? containerId).replace("/", "") || "app";
				const iso = new Date().toISOString();
				return `${name}-${iso.slice(0, 10).replace(/-/g, "")}_${iso
					.slice(11, 19)
					.replace(/:/g, "")}`;
			}}
			toolbarStart={
				<>
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
									onValueChange={(value) => setSince(value as TimeFilter)}
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
								<DropdownMenuLabel>Lines loaded</DropdownMenuLabel>
								<DropdownMenuRadioGroup
									names="lines"
									value={String(lines)}
									onValueChange={(value) => setLines(Number(value))}
								>
									{HISTORY.map((count) => (
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
						</DropdownMenuContent>
					</DropdownMenu>
					{toolbarStart}
				</>
			}
			empty={
				!hasContainer ? (
					"Select a container above to view its logs. If none are listed, make sure the service is deployed and running."
				) : isLoading ? (
					<Loader2 className="size-5 animate-spin" />
				) : (
					(error ?? "No logs yet.")
				)
			}
		/>
	);
};
