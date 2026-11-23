import type { Host } from "../host/types";
import { MAIN_CONFIG_PATH, readYaml, toYaml } from "../infra/traefik/config";
import type { MainTraefikConfig } from "../infra/traefik/types";
import { paths, TRAEFIK_CONTAINER } from "../lib/constants";
import { quote } from "../lib/shell";
import type { LiveConnection } from "./connection";
import {
	errorMessage,
	type SessionContext,
	type SessionHandler,
} from "./session";

// Traefik sees the dynamic directory at the host path, so one path serves both.
export const ACCESS_LOG_PATH = `${paths.traefikDynamic}/access.log`;
const PANEL_SERVICE = "panara-cloud-service-app@file";
const SCAN_LINES = 20_000;
const CACHE_MS = 5000;
const MAX_PAGE_SIZE = 500;
const KEEP_LINES_ON_CLEANUP = 1000;

export type AccessLogEntry = {
	ClientAddr?: string;
	ClientHost?: string;
	DownstreamContentSize?: number;
	DownstreamStatus: number;
	Duration?: number;
	OriginStatus?: number;
	RequestHost?: string;
	RequestMethod?: string;
	RequestPath?: string;
	RequestProtocol?: string;
	RouterName?: string;
	ServiceName?: string;
	StartUTC: string;
	request_User_Agent?: string;
	time?: string;
	[key: string]: unknown;
};

export type StatusRange = "info" | "success" | "redirect" | "client" | "server";

export type AccessLogQuery = {
	page: { pageIndex: number; pageSize: number };
	sort?: { id: string; desc: boolean };
	host?: string;
	path?: string;
	// The client's address, whole: one visitor's requests.
	client?: string;
	method?: string;
	status?: StatusRange[];
	dateRange?: { start?: string; end?: string };
};

// Enables or disables Traefik's JSON access log in its static config.
// Returns whether the file changed (Traefik must restart to apply it).
export const setAccessLog = async (
	host: Host,
	enable: boolean,
	configPath = MAIN_CONFIG_PATH,
): Promise<boolean> => {
	const config = await readYaml<MainTraefikConfig>(host, configPath);
	if (!config) throw new Error(`Traefik config not found at ${configPath}`);
	const enabled = Boolean(config.accessLog?.filePath);
	if (enabled === enable) return false;
	if (enable) {
		config.accessLog = {
			filePath: ACCESS_LOG_PATH,
			format: "json",
			bufferingSize: 100,
		};
	} else {
		delete config.accessLog;
	}
	await host.writeFile(configPath, toYaml(config));
	return true;
};

// Keeps the last lines in place (a rename would break Traefik's open file
// and bind mounts), then asks Traefik to reopen its log.
export const cleanupAccessLog = async (host: Host, path = ACCESS_LOG_PATH) => {
	const file = quote(path);
	await host.run(
		`[ -f ${file} ] || exit 0; tail -n ${KEEP_LINES_ON_CLEANUP} ${file} > ${file}.tmp && cat ${file}.tmp > ${file} && rm -f ${file}.tmp`,
	);
	await host.exec(`docker exec ${TRAEFIK_CONTAINER} kill -USR1 1`);
};

export const parseAccessLog = (text: string): AccessLogEntry[] => {
	const entries: AccessLogEntry[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
		try {
			const entry = JSON.parse(trimmed) as AccessLogEntry;
			if (entry.ServiceName === PANEL_SERVICE) continue;
			entries.push(entry);
		} catch {}
	}
	return entries;
};

const statusIn = (status: number, range: StatusRange) => {
	const base = {
		info: 100,
		success: 200,
		redirect: 300,
		client: 400,
		server: 500,
	}[range];
	return status >= base && status <= base + 99;
};

const inRange = (
	entry: AccessLogEntry,
	range?: AccessLogQuery["dateRange"],
) => {
	if (!range?.start && !range?.end) return true;
	const at = new Date(entry.StartUTC).getTime();
	const start = range.start ? new Date(range.start).getTime() : 0;
	const end = range.end
		? new Date(range.end).getTime()
		: Number.POSITIVE_INFINITY;
	return at >= start && at <= end;
};

const contains = (value: unknown, needle?: string) =>
	!needle ||
	String(value ?? "")
		.toLowerCase()
		.includes(needle.toLowerCase());

export const queryAccessLog = (
	entries: AccessLogEntry[],
	query: AccessLogQuery,
) => {
	const filtered = entries.filter(
		(entry) =>
			inRange(entry, query.dateRange) &&
			contains(entry.RequestHost, query.host) &&
			contains(entry.RequestPath, query.path) &&
			(!query.client || entry.ClientHost === query.client) &&
			(!query.method || entry.RequestMethod === query.method.toUpperCase()) &&
			(!query.status?.length ||
				query.status.some((range) => statusIn(entry.DownstreamStatus, range))),
	);
	const sortId = query.sort?.id ?? "StartUTC";
	const direction = query.sort ? (query.sort.desc ? -1 : 1) : -1;
	filtered.sort((a, b) => {
		const x = a[sortId] as string | number | undefined;
		const y = b[sortId] as string | number | undefined;
		if (x === y) return 0;
		if (x === undefined) return 1;
		if (y === undefined) return -1;
		return (x < y ? -1 : 1) * direction;
	});
	const size = Math.min(Math.max(1, query.page.pageSize), MAX_PAGE_SIZE);
	const start = Math.max(0, query.page.pageIndex) * size;
	return {
		data: filtered.slice(start, start + size),
		totalCount: filtered.length,
	};
};

export const hourlyCounts = (
	entries: AccessLogEntry[],
	dateRange?: AccessLogQuery["dateRange"],
) => {
	const counts = new Map<string, number>();
	for (const entry of entries) {
		if (!inRange(entry, dateRange)) continue;
		const at = new Date(entry.StartUTC);
		if (Number.isNaN(at.getTime())) continue;
		const hour = `${at.toISOString().slice(0, 13)}:00:00Z`;
		counts.set(hour, (counts.get(hour) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([hour, count]) => ({ hour, count }))
		.sort((a, b) => a.hour.localeCompare(b.hour));
};

const STATUS_RANGES = new Set([
	"info",
	"success",
	"redirect",
	"client",
	"server",
]);

const optionalString = (value: unknown, max = 500) =>
	typeof value === "string" && value.length <= max ? value : undefined;

export const parseQuery = (
	payload: Record<string, unknown>,
): AccessLogQuery => {
	const page = (payload.page ?? {}) as Record<string, unknown>;
	const sort = payload.sort as Record<string, unknown> | undefined;
	const dateRange = payload.dateRange as Record<string, unknown> | undefined;
	return {
		page: {
			pageIndex: Number.isInteger(page.pageIndex)
				? (page.pageIndex as number)
				: 0,
			pageSize: Number.isInteger(page.pageSize)
				? (page.pageSize as number)
				: 50,
		},
		sort:
			sort && typeof sort.id === "string" && /^[A-Za-z_]{1,64}$/.test(sort.id)
				? { id: sort.id, desc: sort.desc === true }
				: undefined,
		host: optionalString(payload.host),
		path: optionalString(payload.path),
		client: optionalString(payload.client, 64),
		method: optionalString(payload.method, 16),
		status: Array.isArray(payload.status)
			? (payload.status.filter((s) =>
					STATUS_RANGES.has(s as string),
				) as StatusRange[])
			: undefined,
		dateRange: dateRange
			? {
					start: optionalString(dateRange.start, 64),
					end: optionalString(dateRange.end, 64),
				}
			: undefined,
	};
};

export const readAccessLog = async (
	conn: LiveConnection,
	path = ACCESS_LOG_PATH,
	lines = SCAN_LINES,
) => {
	const result = await conn.run(
		`[ -f ${quote(path)} ] && tail -n ${lines} ${quote(path)} || true`,
		{ maxOutputBytes: 64 * 1024 * 1024 },
	);
	return parseAccessLog(result.stdout);
};

// Paginated, filterable reads of the access log ("Requests"). Each query
// scans the newest SCAN_LINES lines; a short cache serves paging.
export const startAccessLog = async (
	ctx: SessionContext,
	path = ACCESS_LOG_PATH,
): Promise<SessionHandler> => {
	let cache: { at: number; entries: AccessLogEntry[] } | null = null;
	const entries = async () => {
		if (!cache || Date.now() - cache.at > CACHE_MS) {
			cache = { at: Date.now(), entries: await readAccessLog(ctx.conn, path) };
		}
		return cache.entries;
	};
	let queue = Promise.resolve();
	return {
		onMessage: (message) => {
			if (message.type !== "request") return;
			queue = queue.then(async () => {
				try {
					const query = parseQuery(message.payload);
					const data =
						message.op === "query"
							? queryAccessLog(await entries(), query)
							: message.op === "stats"
								? hourlyCounts(await entries(), query.dateRange)
								: null;
					if (data === null)
						throw new Error(`Unknown operation: ${message.op}`);
					ctx.send({ type: "result", id: message.id, ok: true, data });
				} catch (error) {
					ctx.send({
						type: "result",
						id: message.id,
						ok: false,
						error: errorMessage(error),
					});
				}
			});
		},
	};
};
