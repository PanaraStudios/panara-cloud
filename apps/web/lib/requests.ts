/** One line of Traefik's JSON access log. Traefik adds a `request_<Header>`,
    `downstream_<Header>` or `origin_<Header>` key for every header it is set
    to keep. */
export interface AccessEntry {
	ClientAddr?: string;
	ClientHost?: string;
	ClientPort?: string;
	ClientUsername?: string;
	DownstreamContentSize?: number;
	DownstreamStatus: number;
	Duration?: number;
	OriginContentSize?: number;
	OriginDuration?: number;
	OriginStatus?: number;
	Overhead?: number;
	RequestAddr?: string;
	RequestContentSize?: number;
	RequestCount?: number;
	RequestHost?: string;
	RequestMethod?: string;
	RequestPath?: string;
	RequestPort?: string;
	RequestProtocol?: string;
	RequestScheme?: string;
	RetryAttempts?: number;
	RouterName?: string;
	ServiceAddr?: string;
	ServiceName?: string;
	ServiceURL?: { Scheme?: string; Host?: string } | string;
	StartLocal?: string;
	StartUTC: string;
	TLSVersion?: string;
	TLSCipher?: string;
	entryPointName?: string;
	request_User_Agent?: string;
	request_Referer?: string;
	[key: string]: unknown;
}

export interface AccessPage {
	data: AccessEntry[];
	totalCount: number;
}

export type StatusClass = "success" | "redirect" | "client" | "server";

export const statusClass = (status: number): StatusClass | null =>
	status >= 500
		? "server"
		: status >= 400
			? "client"
			: status >= 300
				? "redirect"
				: status >= 200
					? "success"
					: null;

export const nanosToMs = (nanos: number | undefined) =>
	(nanos ?? 0) / 1_000_000;

export function formatDuration(nanos: number | undefined): string {
	const value = nanosToMs(nanos);
	if (value >= 10_000) return `${(value / 1000).toFixed(1)}s`;
	if (value > 0 && value < 1) return "<1ms";
	return `${Math.round(value)}ms`;
}

export function formatBytes(bytes: number | undefined): string {
	const value = bytes ?? 0;
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export const requestTime = (entry: AccessEntry): Date | null => {
	const at = new Date(entry.StartUTC);
	return Number.isNaN(at.getTime()) ? null : at;
};

/** Access-log lines carry no id: what tells two of them apart. */
export const requestKey = (entry: AccessEntry) =>
	`${entry.StartUTC}|${entry.ClientAddr ?? ""}|${entry.RequestMethod ?? ""}|${entry.RequestPath ?? ""}|${entry.DownstreamStatus}|${entry.Duration ?? ""}`;

/** The path and its query, apart: `/api/items?page=2` is a path and one pair. */
export function splitPath(path: string | undefined): {
	path: string;
	query: { key: string; value: string }[];
} {
	const raw = path ?? "";
	const at = raw.indexOf("?");
	if (at === -1) return { path: raw, query: [] };
	const decode = (text: string) => {
		try {
			return decodeURIComponent(text.replace(/\+/g, " "));
		} catch {
			return text;
		}
	};
	const query = raw
		.slice(at + 1)
		.split("&")
		.filter(Boolean)
		.map((pair) => {
			const equals = pair.indexOf("=");
			return equals === -1
				? { key: decode(pair), value: "" }
				: {
						key: decode(pair.slice(0, equals)),
						value: decode(pair.slice(equals + 1)),
					};
		});
	return { path: raw.slice(0, at), query };
}

export const requestUrl = (entry: AccessEntry) =>
	`${entry.RequestScheme || "https"}://${entry.RequestHost ?? ""}${entry.RequestPath ?? ""}`;

const HEADER_GROUPS = [
	["request_", "request"],
	["downstream_", "response"],
	["origin_", "upstream"],
] as const;

/** The headers Traefik kept, as it names them: `request_User_Agent` is the
    request's `User-Agent`. */
export function requestHeaders(entry: AccessEntry) {
	const headers: {
		group: "request" | "response" | "upstream";
		key: string;
		value: string;
	}[] = [];
	for (const [key, value] of Object.entries(entry)) {
		if (value === "" || value === null || value === undefined) continue;
		for (const [prefix, group] of HEADER_GROUPS) {
			if (!key.startsWith(prefix)) continue;
			headers.push({
				group,
				key: key.slice(prefix.length).replace(/_/g, "-"),
				value: String(value),
			});
		}
	}
	return headers;
}

const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

export function curlCommand(entry: AccessEntry): string {
	const method =
		entry.RequestMethod && entry.RequestMethod !== "GET"
			? ` -X ${entry.RequestMethod}`
			: "";
	const agent = entry.request_User_Agent
		? ` -H ${quote(`User-Agent: ${entry.request_User_Agent}`)}`
		: "";
	return `curl${method}${agent} ${quote(requestUrl(entry))}`;
}

/** One request on one line, the way a combined access log prints it. */
export function requestLine(entry: AccessEntry): string {
	return [
		entry.StartUTC,
		entry.RequestMethod ?? "-",
		entry.DownstreamStatus || "-",
		`${entry.RequestHost ?? ""}${entry.RequestPath ?? ""}`,
		formatDuration(entry.Duration),
		entry.ClientHost ?? "-",
	].join(" ");
}

export function percentile(values: readonly number[], p: number) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/**
 * The requests a view holds, oldest first, as pages of the access log arrive:
 * newer ones at the end while it follows, older ones at the start when asked
 * for. A line read twice (pages overlap on their edge) is kept once.
 */
export class RequestBuffer {
	entries: AccessEntry[] = [];
	/** Rows added before the first since the buffer was filled. */
	prepended = 0;
	private seen = new Set<string>();
	private readonly max: number;

	constructor(max = 5000) {
		this.max = max;
	}

	clear() {
		this.entries = [];
		this.prepended = 0;
		this.seen.clear();
	}

	private fresh(incoming: readonly AccessEntry[]) {
		const fresh: AccessEntry[] = [];
		for (const entry of incoming) {
			const key = requestKey(entry);
			if (this.seen.has(key)) continue;
			this.seen.add(key);
			fresh.push(entry);
		}
		// By the moment, not the text: Traefik drops a time's trailing zeros,
		// so `…11.4Z` would sort after `…11.407Z`.
		const at = (entry: AccessEntry) => new Date(entry.StartUTC).getTime();
		return fresh.sort(
			(a, b) =>
				at(a) - at(b) ||
				(a.StartUTC < b.StartUTC ? -1 : a.StartUTC > b.StartUTC ? 1 : 0),
		);
	}

	/** Adds what arrived since; gives how many were new. */
	append(incoming: readonly AccessEntry[]): number {
		const fresh = this.fresh(incoming);
		if (fresh.length === 0) return 0;
		this.entries.push(...fresh);
		const extra = this.entries.length - this.max;
		if (extra > 0) {
			for (const entry of this.entries.splice(0, extra)) {
				this.seen.delete(requestKey(entry));
			}
		}
		return fresh.length;
	}

	/** Adds an older page before what is held; gives how many were new. */
	prepend(incoming: readonly AccessEntry[]): number {
		const fresh = this.fresh(incoming);
		if (fresh.length === 0) return 0;
		this.entries.unshift(...fresh);
		this.prepended += fresh.length;
		return fresh.length;
	}

	get first(): AccessEntry | undefined {
		return this.entries[0];
	}

	get last(): AccessEntry | undefined {
		return this.entries.at(-1);
	}
}
