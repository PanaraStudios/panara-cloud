"use client";

import { api } from "@panara-cloud/backend/api";
import { ArrowRightIcon, ScrollTextIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
	LogEntry,
	LogPage,
} from "@/components/dashboard/requests/show-requests";
import { useAccessLog } from "@/components/dashboard/requests/use-access-log";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
} from "@/components/ui/select";
import { EmptyState } from "@/components/ui-kit/primitives";
import { useQueryResult } from "@/lib/host-data";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { DarkWell, FootNote, SearchField, StatusText } from "./server-ui";
import { useServerRef } from "./use-server";

const SINCE = {
	live: { label: "Live", minutes: 0 },
	"15m": { label: "15 min", minutes: 15 },
	"1h": { label: "1 h", minutes: 60 },
	"24h": { label: "24 h", minutes: 60 * 24 },
} as const;
type Since = keyof typeof SINCE;

const PAGE_SIZE = 200;

const time = (iso: string) => {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const pad = (value: number, size = 2) => String(value).padStart(size, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
};

const lineTone = (status: number) =>
	status >= 500
		? "text-danger"
		: status >= 400
			? "text-warning"
			: "text-terminal-foreground/90";

function AccessLogLines({
	entries,
	following,
}: {
	entries: LogEntry[];
	following: boolean;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!following || !scroller.current) return;
		scroller.current.scrollTop = scroller.current.scrollHeight;
	}, [entries, following]);
	return (
		<div
			ref={scroller}
			className="flex h-full flex-col overflow-auto px-5 py-4 [scrollbar-color:#404040_transparent]"
		>
			<div className="mt-auto">
				{entries.map((entry, index) => {
					const status = entry.DownstreamStatus || entry.OriginStatus;
					const tone = lineTone(status);
					return (
						<div
							// Access log lines have no id; time + position is stable enough.
							key={`${entry.StartUTC}-${index}`}
							className={cn(
								"grid grid-cols-[7.5rem_3.5rem_2.5rem_minmax(10rem,14rem)_minmax(12rem,1fr)_5rem_8rem] gap-x-3 whitespace-nowrap",
								tone,
							)}
						>
							<span className="text-terminal-foreground/50">
								{time(entry.StartUTC)}
							</span>
							<span>{entry.RequestMethod}</span>
							<span>{status || "—"}</span>
							<span className="truncate">{entry.RequestHost}</span>
							<span className="truncate">{entry.RequestPath}</span>
							<span className="text-right">
								{Math.round(entry.Duration / 1e6)}ms
							</span>
							<span
								className={cn(
									"truncate",
									tone === "text-terminal-foreground/90" &&
										"text-terminal-foreground/50",
								)}
							>
								{entry.ClientHost}
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function PanelHostAccessLog() {
	const [query, setQuery] = useState("");
	const [since, setSince] = useState<Since>("live");
	const [errorsOnly, setErrorsOnly] = useState(false);
	const [following, setFollowing] = useState(true);
	const [range, setRange] = useState<{ start: string } | undefined>();

	useEffect(() => {
		const minutes = SINCE[since].minutes;
		setRange(
			minutes
				? { start: new Date(Date.now() - minutes * 60_000).toISOString() }
				: undefined,
		);
	}, [since]);

	const { data, isLoading, error } = useAccessLog<LogPage>(
		"query",
		{
			page: { pageIndex: 0, pageSize: PAGE_SIZE },
			status: errorsOnly ? ["client", "server"] : [],
			dateRange: range,
		},
		{ refetchInterval: following ? 2000 : undefined },
	);

	const entries = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return [...(data?.data ?? [])]
			.reverse()
			.filter(
				(entry) =>
					!needle ||
					entry.RequestHost.toLowerCase().includes(needle) ||
					entry.RequestPath.toLowerCase().includes(needle) ||
					String(entry.DownstreamStatus).startsWith(needle) ||
					entry.ClientHost.includes(needle),
			);
	}, [data, query]);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-2">
				<SearchField
					value={query}
					onChange={setQuery}
					placeholder="Filter by host, path, status…"
				/>
				<Select
					value={since}
					onValueChange={(value) => setSince(value as Since)}
				>
					<SelectTrigger className="w-auto gap-1.5" aria-label="Since">
						<span className="text-muted-foreground">Since</span>
						<span className="font-medium">{SINCE[since].label}</span>
					</SelectTrigger>
					<SelectContent>
						{Object.entries(SINCE).map(([value, option]) => (
							<SelectItem key={value} value={value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Button
					variant="outline"
					size="lg"
					aria-pressed={errorsOnly}
					onClick={() => setErrorsOnly((value) => !value)}
					className={cn(
						errorsOnly ? "bg-muted" : "border-dashed text-muted-foreground",
					)}
				>
					4xx / 5xx only
				</Button>
				<div className="ml-auto flex items-center gap-1">
					{following ? (
						<StatusText tone="success" label="Following" className="px-2" />
					) : (
						<StatusText tone="secondary" label="Paused" className="px-2" />
					)}
					<Button
						variant="outline"
						size="sm"
						onClick={() => setFollowing((value) => !value)}
					>
						{following ? "Pause" : "Follow"}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						nativeButton={false}
						render={<Link href="/activity/requests" />}
					>
						Open in Requests
						<ArrowRightIcon data-icon="inline-end" />
					</Button>
				</div>
			</div>
			<DarkWell className="h-[calc(100svh-27.5rem)] min-h-80">
				{error && !data ? (
					<div className="p-5">
						<p className="text-terminal-foreground/60">
							Couldn't read the access log.
						</p>
						<p className="break-all text-terminal-foreground/50 text-xs">
							{error.message}
						</p>
					</div>
				) : isLoading ? (
					<p className="p-5 text-terminal-foreground/50">Reading access.log…</p>
				) : entries.length === 0 ? (
					<p className="p-5 text-terminal-foreground/50">
						No requests {query || errorsOnly ? "match" : "yet"}.
					</p>
				) : (
					<AccessLogLines entries={entries} following={following} />
				)}
			</DarkWell>
			<FootNote>
				Raw <span className="font-mono text-[13px]">access.log</span> from the
				panel host's Traefik, newest at the bottom. Requests (under Activity)
				adds charts, filters and per-request detail.
			</FootNote>
		</div>
	);
}

export function TraefikAccessLogPage() {
	const ref = useServerRef();
	const { active } = useOrganization();
	const permissions = usePermissions();
	const canRead = permissions.docker.read && permissions.organization.update;
	const status = useQueryResult(
		api.live.accessLog.status,
		canRead && ref.isLocal ? { organizationId: active.id } : "skip",
	);
	if (!canRead) {
		return (
			<EmptyState
				icon={ScrollTextIcon}
				title="Not available"
				description="Your role doesn't include the access log."
			/>
		);
	}
	if (!ref.isLocal) {
		return (
			<EmptyState
				icon={ScrollTextIcon}
				title="No access log on this server"
				description="Panara Cloud keeps the access log of the panel host's Traefik. Requests under Activity shows it with charts and filters."
			>
				<Button
					variant="outline"
					size="sm"
					nativeButton={false}
					render={<Link href="/activity/requests" />}
				>
					Open Requests
				</Button>
			</EmptyState>
		);
	}
	if (status === undefined) return null;
	if (status instanceof Error || !status?.enabled) {
		return (
			<EmptyState
				icon={ScrollTextIcon}
				title="Access log is off"
				description="Turn on request logging in Requests to see every request Traefik serves."
			>
				<Button
					variant="outline"
					size="sm"
					nativeButton={false}
					render={<Link href="/activity/requests" />}
				>
					Open Requests
				</Button>
			</EmptyState>
		);
	}
	return <PanelHostAccessLog />;
}
