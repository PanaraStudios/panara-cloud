"use client";

import { GlobeIcon, Loader2Icon, XIcon } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useAccessLog } from "@/components/dashboard/requests/use-access-log";
import { QuietError } from "@/components/shared/quiet-error";
import { Segmented } from "@/components/shared/segmented";
import { Button } from "@/components/ui/button";
import type { AccessEntry, AccessPage, StatusClass } from "@/lib/requests";
import { FilterSelect } from "./activity-ui";
import { RequestsViewer } from "./requests-viewer";
import { serviceOfTraefikName, useDirectory } from "./use-directory";
import { useRequestFeed } from "./use-request-feed";

type StatusFilter = "all" | StatusClass;
type Range = "1h" | "24h" | "7d";

const RANGES: Record<Range, { label: string; ms: number }> = {
	"1h": { label: "1 h", ms: 3600_000 },
	"24h": { label: "24 h", ms: 24 * 3600_000 },
	"7d": { label: "7 d", ms: 7 * 24 * 3600_000 },
};

const HOST_SAMPLE = 500;

/** What the filters above the list ask for, for figures that follow them. */
export interface RequestFilters {
	host?: string;
	path?: string;
	client?: string;
	dateRange: { start: string };
}

/**
 * The panel host's access log as a list that follows new requests: the
 * filters, the feed and the viewer together. `banner` draws between the
 * filters and the list.
 */
export function RequestsLog({
	className,
	actions,
	banner,
	defaultRange = "24h",
}: {
	className?: string;
	actions?: ReactNode;
	banner?: (filters: RequestFilters) => ReactNode;
	defaultRange?: Range;
}) {
	const directory = useDirectory();
	const [path, setPath] = useState("");
	const [host, setHost] = useState("all");
	const [client, setClient] = useState("");
	const [status, setStatus] = useState<StatusFilter>("all");
	const [range, setRange] = useState<Range>(defaultRange);
	const [knownHosts, setKnownHosts] = useState<string[]>([]);
	// Typing asks the agent once it pauses, not on every key.
	const [query, setQuery] = useState("");
	useEffect(() => {
		const timer = setTimeout(() => setQuery(path.trim()), 300);
		return () => clearTimeout(timer);
	}, [path]);
	// Rounded to the minute so what is asked for (and the poll behind it)
	// only changes once a minute.
	const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
	useEffect(() => {
		const timer = setInterval(
			() => setMinute(Math.floor(Date.now() / 60_000)),
			15_000,
		);
		return () => clearInterval(timer);
	}, []);

	const filters: RequestFilters = {
		host: host === "all" ? undefined : host,
		path: query || undefined,
		client: client || undefined,
		dateRange: {
			start: new Date(minute * 60_000 - RANGES[range].ms).toISOString(),
		},
	};
	const feed = useRequestFeed({
		host: filters.host,
		path: filters.path,
		client: filters.client,
		status: status === "all" ? undefined : status,
		rangeMs: RANGES[range].ms,
	});

	// The host picker lists every host seen in the range, whatever else is
	// filtered.
	const hosts = useAccessLog<AccessPage>(
		"query",
		{
			dateRange: filters.dateRange,
			page: { pageIndex: 0, pageSize: HOST_SAMPLE },
		},
		{ refetchInterval: 30_000 },
	);
	useEffect(() => {
		const seen = hosts.data?.data.map((entry) => entry.RequestHost) ?? [];
		if (seen.length === 0) return;
		setKnownHosts((previous) => {
			const next = new Set([
				...previous,
				...seen.filter((item): item is string => !!item),
			]);
			return next.size === previous.length ? previous : [...next].sort();
		});
	}, [hosts.data]);

	// An agent from before the client filter answers with every client's
	// requests: the list keeps only the one asked for either way.
	const entries = useMemo(
		() =>
			client
				? feed.buffer.entries.filter((entry) => entry.ClientHost === client)
				: feed.buffer.entries,
		[feed.buffer, feed.version, client],
	);
	const serviceOf = useCallback(
		(entry: AccessEntry) =>
			serviceOfTraefikName(entry.ServiceName ?? "", directory.byAppName),
		[directory.byAppName],
	);
	const filtered = host !== "all" || !!query || !!client || status !== "all";

	if (feed.error && !feed.loaded) {
		return (
			<QuietError
				message="Couldn't read the access log on the panel host."
				detail={feed.error}
			/>
		);
	}
	return (
		<RequestsViewer
			entries={entries}
			version={feed.version}
			total={client ? undefined : feed.total}
			prepended={feed.buffer.prepended}
			older={feed.older}
			follow
			status={feed.status}
			search={path}
			onSearch={setPath}
			serviceOf={serviceOf}
			onFilterClient={setClient}
			onFilterStatus={setStatus}
			resetKey={`${host}:${query}:${client}:${status}:${range}`}
			className={className}
			actions={actions}
			banner={banner?.(filters)}
			filters={
				<>
					<FilterSelect
						names="domain"
						label="Host"
						value={host}
						onValueChange={setHost}
						options={knownHosts.map((item) => ({ value: item, label: item }))}
					/>
					<Segmented
						aria-label="Status class"
						value={status}
						onValueChange={setStatus}
						items={[
							{ value: "all", label: "All" },
							{ value: "success", label: "2xx" },
							{ value: "redirect", label: "3xx" },
							{ value: "client", label: "4xx" },
							{ value: "server", label: "5xx" },
						]}
					/>
					{client ? (
						<Button
							variant="outline"
							size="sm"
							className="h-8 gap-1.5 font-mono text-[13px]"
							aria-label={`Showing ${client} only. Clear`}
							title="Show every client"
							onClick={() => setClient("")}
						>
							<GlobeIcon className="text-muted-foreground" />
							{client}
							<XIcon className="size-3.5 text-muted-foreground" />
						</Button>
					) : null}
					<FilterSelect
						label="Last"
						value={range === "24h" ? "all" : range}
						onValueChange={(value) =>
							setRange(value === "1h" || value === "7d" ? value : "24h")
						}
						allLabel="24 h"
						options={(["1h", "7d"] as const).map((value) => ({
							value,
							label: RANGES[value].label,
						}))}
					/>
				</>
			}
			empty={
				!feed.loaded ? (
					<Loader2Icon className="size-5 animate-spin" />
				) : filtered ? (
					"No requests match these filters."
				) : (
					"No requests logged yet. If you just turned logging on, reload Traefik from the panel host's Traefik page."
				)
			}
		/>
	);
}
