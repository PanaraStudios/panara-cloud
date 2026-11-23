"use client";

import {
	BracesIcon,
	GlobeIcon,
	HashIcon,
	HistoryIcon,
	RouteIcon,
	ScrollTextIcon,
	TerminalIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import {
	Block,
	DetailPanel,
	Fact,
	Facts,
	FieldList,
	PRE,
} from "@/components/dashboard/docker/logs/detail-panel";
import {
	formatLocal,
	highlight,
	TIME_SLOT,
	TimeCell,
	timeTitle,
} from "@/components/dashboard/docker/logs/log-text";
import type {
	RowTone,
	ViewerColumn,
} from "@/components/dashboard/docker/logs/viewer-list";
import {
	type DetailControls,
	ViewerShell,
	type ViewerStatus,
} from "@/components/dashboard/docker/logs/viewer-shell";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/components/ui-kit/primitives";
import {
	type AccessEntry,
	curlCommand,
	formatBytes,
	formatDuration,
	nanosToMs,
	requestHeaders,
	requestKey,
	requestLine,
	requestTime,
	requestUrl,
	type StatusClass,
	splitPath,
	statusClass,
} from "@/lib/requests";
import Link from "@/lib/router/link";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { DirectoryService } from "./use-directory";

// The colours a log's levels use: quiet when fine, blue for a redirect,
// amber for the client's mistake, red for ours.
const STATUS_TEXT: Record<StatusClass, string> = {
	success: "text-terminal-foreground/60",
	redirect: "text-info",
	client: "text-warning",
	server: "text-destructive",
};

const statusText = (status: number) => {
	const kind = statusClass(status);
	return kind ? STATUS_TEXT[kind] : "text-terminal-foreground/40";
};

const requestTone = (entry: AccessEntry): RowTone =>
	entry.DownstreamStatus >= 500
		? "error"
		: entry.DownstreamStatus >= 400
			? "warn"
			: null;

const upstreamOf = (entry: AccessEntry) => {
	const url = entry.ServiceURL;
	if (typeof url === "string" && url) return url;
	if (url && typeof url === "object" && url.Host) {
		return `${url.Scheme || "http"}://${url.Host}`;
	}
	return entry.ServiceAddr || null;
};

function Timing({ entry }: { entry: AccessEntry }) {
	const total = nanosToMs(entry.Duration);
	const origin = nanosToMs(entry.OriginDuration);
	const overhead = Math.max(0, total - origin);
	const failed = entry.DownstreamStatus >= 500;
	return (
		<div className="flex flex-col gap-2">
			<div className="flex h-1.5 overflow-hidden rounded-full bg-terminal-foreground/10">
				<div
					className="bg-terminal-foreground/35"
					style={{ width: `${total ? (overhead / total) * 100 : 0}%` }}
				/>
				<div
					className={failed ? "bg-destructive" : "bg-terminal-foreground/70"}
					style={{ width: `${total ? (origin / total) * 100 : 0}%` }}
				/>
			</div>
			<Facts>
				<Fact label="Total">{formatDuration(entry.Duration)}</Fact>
				<Fact
					label="Upstream"
					className={failed ? "text-destructive" : undefined}
				>
					{formatDuration(entry.OriginDuration)}
					{entry.OriginStatus === 0 && failed ? " · no response" : ""}
				</Fact>
				<Fact label="Traefik">{`${overhead < 1 && overhead > 0 ? "<1" : Math.round(overhead)}ms`}</Fact>
				{entry.RetryAttempts ? (
					<Fact label="Retries">{entry.RetryAttempts}</Fact>
				) : null}
			</Facts>
		</div>
	);
}

interface DetailProps extends DetailControls {
	entry: AccessEntry;
	service: DirectoryService | undefined;
	onFilterPath: (path: string) => void;
	onFilterClient: (client: string) => void;
	onFilterStatus: (status: StatusClass) => void;
}

/** Everything the access log holds about one request. */
function RequestDetail({
	entry,
	service,
	pattern,
	onFilterPath,
	onFilterClient,
	onFilterStatus,
	...controls
}: DetailProps) {
	const time = requestTime(entry);
	const url = requestUrl(entry);
	const { path, query } = splitPath(entry.RequestPath);
	const headers = requestHeaders(entry);
	const kind = statusClass(entry.DownstreamStatus);
	const upstream = upstreamOf(entry);
	const contentType = headers.find(
		(header) =>
			header.group === "response" &&
			header.key.toLowerCase() === "content-type",
	)?.value;
	const groups = (["request", "response", "upstream"] as const)
		.map((group) => ({
			group,
			fields: headers
				.filter((header) => header.group === group)
				.map(({ key, value }) => ({ key, value })),
		}))
		.filter((item) => item.fields.length > 0);
	return (
		<DetailPanel
			label="Request"
			noun="request"
			copyText={JSON.stringify(entry, null, 2)}
			title={
				<>
					<span
						className={cn(
							"font-mono text-[13px]",
							statusText(entry.DownstreamStatus),
						)}
					>
						{entry.DownstreamStatus || "—"}
					</span>
					<span className="font-mono text-[13px]">{entry.RequestMethod}</span>
					<span className="min-w-0 truncate text-[13px] text-terminal-foreground/60">
						{time ? relativeTime(time.getTime()) : "Request"}
					</span>
				</>
			}
			{...controls}
		>
			<Block title="URL" copyText={url}>
				<pre className={PRE}>{highlight(url, pattern)}</pre>
				<div className="flex flex-wrap gap-1.5 pt-1.5">
					<Button
						variant="outline"
						size="xs"
						onClick={() => onFilterPath(path)}
					>
						<RouteIcon />
						Filter by this path
					</Button>
					{entry.ClientHost ? (
						<Button
							variant="outline"
							size="xs"
							onClick={() => onFilterClient(entry.ClientHost ?? "")}
						>
							<GlobeIcon />
							Filter by this IP
						</Button>
					) : null}
					{kind ? (
						<Button
							variant="outline"
							size="xs"
							onClick={() => onFilterStatus(kind)}
						>
							<HashIcon />
							Filter by {String(entry.DownstreamStatus)[0]}xx
						</Button>
					) : null}
				</div>
			</Block>
			<Block title="Request">
				<Facts>
					<Fact label="Method">{entry.RequestMethod ?? "—"}</Fact>
					<Fact label="Host">{entry.RequestHost ?? "—"}</Fact>
					<Fact label="Path">{path || "/"}</Fact>
					<Fact label="Protocol">
						{[
							entry.RequestProtocol,
							entry.RequestScheme,
							entry.TLSVersion ? `TLS ${entry.TLSVersion}` : "",
						]
							.filter(Boolean)
							.join(" · ") || "—"}
					</Fact>
					<Fact label="Body">{formatBytes(entry.RequestContentSize)}</Fact>
				</Facts>
			</Block>
			{query.length > 0 ? (
				<Block title="Query" count={query.length}>
					<FieldList fields={query} pattern={pattern} />
				</Block>
			) : null}
			<Block title="Response">
				<Facts>
					<Fact label="Status" className={statusText(entry.DownstreamStatus)}>
						{entry.DownstreamStatus || "—"}
					</Fact>
					{entry.OriginStatus !== undefined &&
					entry.OriginStatus !== entry.DownstreamStatus ? (
						<Fact label="From upstream">
							{entry.OriginStatus === 0 ? "no response" : entry.OriginStatus}
						</Fact>
					) : null}
					<Fact label="Size">{formatBytes(entry.DownstreamContentSize)}</Fact>
					{contentType ? <Fact label="Type">{contentType}</Fact> : null}
				</Facts>
			</Block>
			<Block title="Timing">
				<Timing entry={entry} />
			</Block>
			<Block title="Routed to">
				<Facts>
					<Fact label="Service" className="font-sans">
						{service?.href ? (
							<Link
								href={service.href}
								className="underline-offset-2 hover:underline"
							>
								{service.projectName} / {service.name}
							</Link>
						) : (
							<span className="font-mono">{entry.ServiceName || "—"}</span>
						)}
					</Fact>
					{entry.RouterName ? (
						<Fact label="Router">{entry.RouterName}</Fact>
					) : null}
					{upstream ? <Fact label="Upstream">{upstream}</Fact> : null}
					{entry.entryPointName ? (
						<Fact label="Entry point">{entry.entryPointName}</Fact>
					) : null}
				</Facts>
			</Block>
			<Block title="Client">
				<Facts>
					<Fact label="IP">
						{entry.ClientHost ?? "—"}
						{entry.ClientPort ? (
							<span className="text-terminal-foreground/50">
								:{entry.ClientPort}
							</span>
						) : null}
					</Fact>
					{entry.ClientUsername && entry.ClientUsername !== "-" ? (
						<Fact label="User">{entry.ClientUsername}</Fact>
					) : null}
					{entry.request_User_Agent ? (
						<Fact label="User agent">{entry.request_User_Agent}</Fact>
					) : null}
					{entry.request_Referer ? (
						<Fact label="Referrer">{entry.request_Referer}</Fact>
					) : null}
				</Facts>
			</Block>
			{groups.map(({ group, fields }) => (
				<Block
					key={group}
					title={
						group === "request"
							? "Request headers"
							: group === "response"
								? "Response headers"
								: "Upstream headers"
					}
					count={fields.length}
				>
					<FieldList fields={fields} pattern={pattern} />
				</Block>
			))}
			<Block title="Details">
				<Facts>
					{time ? (
						<>
							<Fact label="Time">{formatLocal(time)}</Fact>
							<Fact label="UTC">{time.toISOString()}</Fact>
						</>
					) : (
						<Fact label="Time">{entry.StartUTC}</Fact>
					)}
					{entry.RequestCount ? (
						<Fact label="Request no.">
							{entry.RequestCount.toLocaleString()}
						</Fact>
					) : null}
				</Facts>
				<div className="flex flex-wrap gap-1.5 pt-2">
					<Button
						variant="outline"
						size="xs"
						onClick={() => copyToClipboard(curlCommand(entry), "curl command")}
					>
						<TerminalIcon />
						Copy as curl
					</Button>
					<Button
						variant="outline"
						size="xs"
						onClick={() =>
							copyToClipboard(JSON.stringify(entry, null, 2), "Request")
						}
					>
						<BracesIcon />
						Copy JSON
					</Button>
					{service?.href ? (
						<Button
							variant="outline"
							size="xs"
							nativeButton={false}
							render={<Link href={`${service.href}/logs`} />}
						>
							<ScrollTextIcon />
							Open {service.name} logs
						</Button>
					) : null}
				</div>
			</Block>
		</DetailPanel>
	);
}

function PathCell({
	entry,
	pattern,
}: {
	entry: AccessEntry;
	pattern: RegExp | null;
}) {
	const raw = entry.RequestPath ?? "";
	const at = raw.indexOf("?");
	if (at === -1) return <>{highlight(raw, pattern)}</>;
	return (
		<>
			{highlight(raw.slice(0, at), pattern)}
			<span className="text-terminal-foreground/45">
				{highlight(raw.slice(at), pattern)}
			</span>
		</>
	);
}

export interface OlderRequests {
	/** How many older requests the range still holds, when known. */
	remaining: number | null;
	loading: boolean;
	load: () => void;
}

interface Props {
	/** Every request held, oldest first. */
	entries: readonly AccessEntry[];
	/** Changes when `entries` did. */
	version: unknown;
	/** Requests in the range that match the filters, loaded or not. */
	total?: number;
	prepended?: number;
	older?: OlderRequests;
	follow?: boolean;
	status?: ViewerStatus;
	search: string;
	onSearch: (value: string) => void;
	/** The host, status and range pickers. */
	filters?: ReactNode;
	/** Controls before wrap, copy and download. */
	actions?: ReactNode;
	/** Between the toolbar and the list. */
	banner?: ReactNode;
	serviceOf: (entry: AccessEntry) => DirectoryService | undefined;
	onFilterClient: (client: string) => void;
	onFilterStatus: (status: StatusClass) => void;
	empty: ReactNode;
	className?: string;
	resetKey?: string;
}

/**
 * Requests in the log viewer's frame: one dense row per request with the
 * status in a level's colour, the whole request beside the list, and a tail
 * that follows new requests until you scroll away or open one.
 */
export function RequestsViewer({
	entries,
	version,
	total,
	prepended,
	older,
	follow = false,
	status,
	search,
	onSearch,
	filters,
	actions,
	banner,
	serviceOf,
	onFilterClient,
	onFilterStatus,
	empty,
	className,
	resetKey,
}: Props) {
	const [wrap, setWrap] = useState(false);
	// Paused: the list stops at the request that was newest then.
	const [frozen, setFrozen] = useState<AccessEntry | null>(null);
	const rows = useMemo(() => {
		if (frozen === null) return entries;
		const end = entries.lastIndexOf(frozen);
		return end === -1 ? entries : entries.slice(0, end + 1);
	}, [entries, version, frozen]);
	const pattern = useMemo(() => {
		const needle = search.trim();
		return needle
			? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
			: null;
	}, [search]);

	const columns = useMemo<ViewerColumn<AccessEntry>[]>(
		() => [
			{
				id: "time",
				header: "Time",
				className: TIME_SLOT,
				cellClassName: "text-terminal-foreground/50",
				title: (entry) => timeTitle(requestTime(entry)),
				cell: (entry) => <TimeCell time={requestTime(entry)} />,
			},
			{
				id: "method",
				header: "Method",
				className: "w-14 shrink-0",
				cellClassName: "text-terminal-foreground/70",
				cell: (entry) => entry.RequestMethod ?? "",
			},
			{
				id: "status",
				header: "Status",
				className: "w-10 shrink-0",
				cellClassName: (entry) => statusText(entry.DownstreamStatus),
				cell: (entry) => entry.DownstreamStatus || "—",
			},
			{
				id: "path",
				header: "Path",
				grow: true,
				className: "min-w-0 flex-1",
				cellClassName: (entry, { wrap }) =>
					cn(
						wrap
							? "whitespace-pre-wrap [overflow-wrap:anywhere]"
							: "truncate whitespace-pre",
						entry.DownstreamStatus >= 500
							? "text-destructive"
							: "text-terminal-foreground/90",
					),
				cell: (entry, { pattern }) => (
					<PathCell entry={entry} pattern={pattern} />
				),
			},
			{
				id: "service",
				header: "Service",
				className: "w-52 shrink-0 truncate @max-4xl/viewer:hidden",
				cellClassName: "font-sans text-terminal-foreground/70",
				cell: (entry) => {
					const service = serviceOf(entry);
					return service
						? `${service.projectName} / ${service.name}`
						: (entry.RequestHost ?? "");
				},
			},
			{
				id: "duration",
				header: "Duration",
				className: "w-16 shrink-0 text-right tabular-nums",
				cellClassName: (entry) =>
					entry.DownstreamStatus >= 500
						? "text-destructive"
						: "text-terminal-foreground/70",
				cell: (entry) => formatDuration(entry.Duration),
			},
			{
				id: "client",
				header: "Client IP",
				className: "w-32 shrink-0 truncate @max-2xl/viewer:hidden",
				cellClassName: "text-terminal-foreground/50",
				cell: (entry) => entry.ClientHost ?? "",
			},
		],
		[serviceOf],
	);

	const detail = useCallback(
		(entry: AccessEntry, controls: DetailControls) => (
			<RequestDetail
				entry={entry}
				service={serviceOf(entry)}
				onFilterPath={onSearch}
				onFilterClient={onFilterClient}
				onFilterStatus={onFilterStatus}
				{...controls}
			/>
		),
		[serviceOf, onSearch, onFilterClient, onFilterStatus],
	);
	const onPausedChange = useCallback(
		(paused: boolean) => setFrozen(paused ? (entries.at(-1) ?? null) : null),
		[entries],
	);
	const isGone = useCallback(
		(entry: AccessEntry) => !entries.includes(entry),
		[entries, version],
	);
	const text = useCallback(() => rows.map(requestLine).join("\n"), [rows]);

	return (
		<ViewerShell
			label="Requests"
			kind="requests"
			rows={rows}
			version={version}
			rowId={requestKey}
			rowTone={requestTone}
			isGone={isGone}
			columns={columns}
			detail={detail}
			search={search}
			onSearch={onSearch}
			searchLabel="Filter by path"
			pattern={pattern}
			filters={filters}
			actions={actions}
			banner={banner}
			wrap={wrap}
			onWrap={setWrap}
			text={text}
			rowText={requestLine}
			fileName={() =>
				`requests-${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "")}.log.txt`
			}
			copyLabel="Copy requests"
			follow={follow}
			status={status}
			pending={entries.length - rows.length}
			onPausedChange={onPausedChange}
			prepended={prepended}
			className={className}
			resetKey={resetKey}
			empty={empty}
			summary={
				entries.length === 0
					? null
					: total !== undefined && total > rows.length
						? `${rows.length.toLocaleString()} of ${total.toLocaleString()}`
						: `${rows.length.toLocaleString()} ${rows.length === 1 ? "request" : "requests"}`
			}
			end={
				older && entries.length > 0 ? (
					<div className="flex h-10 items-center justify-center gap-2 px-4 text-muted-foreground text-xs">
						{older.remaining === 0 ? (
							"The first request in this range."
						) : (
							<Button
								variant="ghost"
								size="xs"
								isLoading={older.loading}
								onClick={older.load}
							>
								<HistoryIcon />
								Load older requests
								{older.remaining ? (
									<span className="text-muted-foreground tabular-nums">
										{older.remaining.toLocaleString()} more
									</span>
								) : null}
							</Button>
						)}
					</div>
				) : null
			}
		/>
	);
}
