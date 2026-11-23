export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";
export type LogStream = "stdout" | "stderr";
/** `mixed` is text that ends in a JSON object (zap's console output, Caddy);
    `access` is a web server's combined access line. */
export type LogFormat = "json" | "logfmt" | "mixed" | "access" | "text";

export interface LogField {
	key: string;
	value: string;
}

export interface LogEntry {
	id: number;
	/** A section is a quiet marker between runs of lines (a build step). */
	kind: "entry" | "section";
	timestamp: Date | null;
	rawTimestamp: string | null;
	level: LogLevel | null;
	/** Where the line came from when the output names it: the container or
	    replica, or the file a `tail` of several files printed it from. */
	source: string | null;
	/** The tailed file's path, when `source` is one. */
	file: string | null;
	stream: LogStream | null;
	/** One line: what the program said, without the timestamp and level it
	    printed (those have their own columns). Keeps the colour codes. */
	message: string;
	/** The logger or component the line names. */
	logger: string | null;
	/** The program's own timestamp as printed, when the message leaves it out. */
	appTimestamp: string | null;
	/** The line as printed, without the runtime's timestamp. */
	raw: string;
	/** `raw` without colour codes: what search, copy and download use. */
	text: string;
	format: LogFormat;
	fields: LogField[];
	/** Lines that continue this entry: stack frames, statement details. */
	attached: string[];
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
// Colour and cursor sequences, and OSC sequences such as hyperlinks.
const ANSI = new RegExp(
	`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
	"g",
);

export function stripAnsi(text: string): string {
	return text.includes(ESC) ? text.replace(ANSI, "") : text;
}

const LEVEL_NAMES: Record<string, LogLevel> = {
	trace: "trace",
	trac: "trace",
	trc: "trace",
	verbose: "trace",
	silly: "trace",
	finest: "trace",
	debug: "debug",
	debu: "debug",
	dbg: "debug",
	dbug: "debug",
	info: "info",
	inf: "info",
	information: "info",
	informational: "info",
	notice: "info",
	log: "info",
	warn: "warn",
	warning: "warn",
	wrn: "warn",
	error: "error",
	erro: "error",
	eror: "error",
	err: "error",
	fatal: "error",
	fata: "error",
	ftl: "error",
	critical: "error",
	crit: "error",
	panic: "error",
	pani: "error",
	alert: "error",
	emerg: "error",
	emergency: "error",
	severe: "error",
};

const SEVERITY: Record<LogLevel, number> = {
	trace: 0,
	debug: 1,
	info: 2,
	warn: 3,
	error: 4,
};

export function levelFromName(name: string): LogLevel | null {
	return LEVEL_NAMES[name.toLowerCase()] ?? null;
}

export function levelFromNumber(level: number): LogLevel | null {
	if (!Number.isFinite(level)) return null;
	// pino and bunyan: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal.
	if (level >= 50) return "error";
	if (level >= 40) return "warn";
	if (level >= 30) return "info";
	if (level >= 20) return "debug";
	if (level >= 10) return "trace";
	// syslog: 0 emergency … 3 error, 4 warning, 5 notice, 6 info, 7 debug.
	if (level < 0) return null;
	if (level <= 3) return "error";
	if (level === 4) return "warn";
	if (level <= 6) return "info";
	return "debug";
}

const statusLevel = (status: number): LogLevel =>
	status >= 500 ? "error" : status >= 400 ? "warn" : "info";

/** A response status only ever raises what the logger itself said: an
    access line logged at "info" with a 502 still reads as an error. */
function raiseForStatus(level: LogLevel | null, status: number | null) {
	if (status === null || status < 100 || status > 599) return level;
	const fromStatus = statusLevel(status);
	if (level === null) return fromStatus;
	return SEVERITY[fromStatus] > SEVERITY[level] ? fromStatus : level;
}

// The container runtime's own prefix (`docker logs --timestamps`).
const RUNTIME_TIMESTAMP =
	/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})) ?/;

// `web-1  | ` (Docker Compose) and `web.1.k3x9@node-2    | ` (Swarm).
const SOURCE_PREFIX =
	/^([A-Za-z0-9][\w.-]*-\d+|[A-Za-z0-9][\w-]*\.\d+\.[a-z0-9]+@[\w.-]+)\s+\| ?/;

const DATE = String.raw`\d{4}[-/]\d{2}[-/]\d{2}`;
const CLOCK = String.raw`\d{2}:\d{2}:\d{2}(?:[.,]\d+)?`;
const ZONE = String.raw`(?:Z| ?[+-]\d{2}:?\d{2}| UTC| GMT)`;
// Sticky: read at a position, so a level may come before the timestamp.
const APP_TIMESTAMP = new RegExp(
	[
		String.raw`\[?(${DATE}[T ]${CLOCK}(${ZONE})?)\]?`,
		String.raw`\[(\d{2}/\w{3}/\d{4}:${CLOCK} [+-]\d{4})\]`,
		String.raw`([A-Z][a-z]{2} [ \d]\d ${CLOCK})(?= )`,
		String.raw`\[?(${CLOCK})\]?(?=[ \t])`,
	].join("|"),
	"y",
);
const AFTER_TIMESTAMP = /[ \t]*(?:[-|][ \t]+)?/y;

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

function validDate(iso: string): Date | null {
	const parsed = new Date(iso);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** `21/Nov/2026:10:15:42 +0000`, the way access logs print a time. */
function accessDate(text: string): Date | null {
	const match =
		/^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/.exec(
			text,
		);
	if (!match) return null;
	const month = MONTHS.indexOf(match[2] ?? "");
	if (month === -1) return null;
	return validDate(
		`${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1]}T${match[4]}${match[5]}:${match[6]}`,
	);
}

interface AppTimestamp {
	/** As printed, without brackets. */
	printed: string;
	end: number;
	/** Only when the program printed a zone: a bare local time can't be placed. */
	date: Date | null;
}

function timestampAt(text: string, at: number): AppTimestamp | null {
	APP_TIMESTAMP.lastIndex = at;
	const match = APP_TIMESTAMP.exec(text);
	if (!match) return null;
	let date: Date | null = null;
	if (match[1] && match[2]) {
		date = validDate(
			match[1]
				.replace(/\//g, "-")
				.replace(" ", "T")
				.replace(",", ".")
				.replace(/ (?:UTC|GMT)$/, "Z")
				.replace(/ ?([+-]\d{2}):?(\d{2})$/, "$1:$2"),
		);
	} else if (match[3]) {
		date = accessDate(match[3]);
	}
	return {
		printed: match[1] ?? match[3] ?? match[4] ?? match[5] ?? "",
		end: at + match[0].length,
		date,
	};
}

const skip = (pattern: RegExp, text: string, at: number) => {
	pattern.lastIndex = at;
	return at + (pattern.exec(text)?.[0].length ?? 0);
};

function splitAppTimestamp(text: string) {
	const stamp = timestampAt(text, 0);
	if (!stamp) return null;
	const rest = text.slice(skip(AFTER_TIMESTAMP, text, stamp.end));
	return rest ? { rest, date: stamp.date } : null;
}

const LEVEL_WORDS = Object.keys(LEVEL_NAMES).join("|");
const KLOG = /^([IWEF])\d{4} \d{2}:\d{2}:\d{2}\.\d+/;
const REDIS = /^\d+:[XCSM] \d{1,2} \w{3} \d{4} [\d:.]+ ([.\-*#]) /;
const KEY_VALUE_LEVEL = /(?:^|\s)(?:level|lvl|severity)=("?)([A-Za-z]+)\1/;
const LEADING_DELIMITED = new RegExp(
	String.raw`^[\[<|]\s*(${LEVEL_WORDS})\s*[\]>|]`,
	"i",
);
const LEADING_COLON = new RegExp(String.raw`^(${LEVEL_WORDS})\d?:`, "i");
const LEADING_BARE =
	/^(error|warn|warning|info|fatal|panic|Error|Warning|Info|Fatal)\s/;
const LEADING_UPPER =
	/^(TRACE|DEBUG|DEBU|INFO|NOTICE|WARN|WARNING|ERROR|ERRO|ERR|FATAL|FATA|CRITICAL|CRIT|PANIC|SEVERE|LOG)(?=[\s[\]:|-]|$)/;
const HEAD_DELIMITED = new RegExp(
	String.raw`[\[<|]\s*(${LEVEL_WORDS})\s*[\]>|]`,
	"i",
);
const HEAD_UPPER =
	/(?<![\w.\-/"'=])(TRACE|DEBUG|DEBU|INFO|NOTICE|WARN|WARNING|ERROR|ERRO|ERR|FATAL|FATA|CRITICAL|PANIC|SEVERE|LOG)(?![\w\-/"'=.])/;
const DIAGNOSTIC =
	/(?:^|[\s:(])(fatal error|error|warning)(?:\[[A-Z]?\d+\])?(?: [A-Z]{1,6}\d+)?:/;
const THROWN =
	/^(?:Uncaught |Unhandled )?[\w.$]*(?:Error|Exception)(?::|\s*$)|^Exception in thread |^Traceback \(most recent call last\):|^panic: |^fatal error: |^thread '.*' panicked at |^Unhandled(?:Promise)?Rejection/;
const BUILDKIT_STEP = /^#\d+ (?:\d+\.\d+ )?/;
const BUILD_FAILURE =
	/^(?:Failed to compile|Build failed|Compilation failed|BUILD FAILED)\b/;
const HEAD_LENGTH = 80;

const KLOG_LEVELS: Record<string, LogLevel> = {
	I: "info",
	W: "warn",
	E: "error",
	F: "error",
};
const REDIS_LEVELS: Record<string, LogLevel> = {
	".": "debug",
	"-": "debug",
	"*": "info",
	"#": "warn",
};

const UPPER_LEVELS =
	"TRACE|DEBUG|DEBU|INFO|NOTICE|WARN|WARNING|ERROR|ERRO|ERR|FATAL|FATA|CRITICAL|CRIT|PANIC|SEVERE|LOG";
const AT_DELIMITED = new RegExp(
	String.raw`[\[<|(]\s*(${LEVEL_WORDS})\s*[\]>|)]:?`,
	"iy",
);
const AT_COLON = new RegExp(String.raw`(${LEVEL_WORDS})\d?:`, "iy");
// `WARN[0001]` is logrus counting seconds.
const AT_UPPER = new RegExp(
	String.raw`(${UPPER_LEVELS})(?:\[\d+\])?(?=[\s[\]:|-]|$)`,
	"y",
);
// A bare word is a level only after a timestamp: "error reading config" at
// the start of a line is a sentence.
const AT_BARE =
	/(error|warn|warning|info|debug|trace|fatal|panic|notice|Error|Warning|Info|Debug|Fatal)(?=[ \t])/y;
const AFTER_LEVEL = /[ \t]*(?:[-|:][ \t]+)?/y;
const AT_GROUP = /\[([^\]\s][^\]]{0,39})\][ \t]*/y;
const AT_PYTHON_LOGGER =
	/([A-Za-z_][\w.]*) - (?=(?:DEBUG|INFO|WARNING|ERROR|CRITICAL) - )/y;
const AT_PYTHON_BASIC = /([A-Za-z_][\w.]*):(?=\S)/y;
const AT_MONOLOG = new RegExp(
	String.raw`([A-Za-z][\w-]*)\.(${UPPER_LEVELS}):[ \t]+`,
	"y",
);
const AT_SPRING = /(\d+) --- \[\s*([^\]]*?)\s*\] (\S+)\s+: /y;
const AT_NGINX_PID = /(\d+)#\d+: /y;
const AT_LOGGER_GROUP = /\[([A-Za-z][\w.:$/-]{0,39})\][ \t]+/y;
const AT_PID_GROUP = /\[(\d+)\]:?[ \t]+/y;
const AT_DOTTED_LOGGER = /([A-Za-z_$][\w$]*(?:\.[\w$]+){2,})[ \t]+[-:][ \t]+/y;
const AT_LOGURU = /([\w.<>]+:[\w<>]+:\d+) - /y;
const KLOG_LINE =
	/^([IWEF])(\d{4} \d{2}:\d{2}:\d{2}\.\d+)\s+(\d+)\s+(\S+:\d+)\]\s+/;
const REDIS_LINE = /^(\d+):([XCSM]) (\d{1,2} \w{3} \d{4} [\d:.]+) ([.\-*#]) /;
const NEST_LINE = new RegExp(
	String.raw`^\[Nest\] (\d+)\s+- (\d{2}/\d{2}/\d{4}, \d{1,2}:\d{2}:\d{2} [AP]M)\s+(${UPPER_LEVELS}|VERBOSE)\s+(?:\[([^\]]+)\] )?`,
);

interface Prefix {
	/** Where what the program said starts. */
	end: number;
	/** The timestamp as printed and where it sits in the line. */
	stamp: { printed: string; start: number; end: number } | null;
	date: Date | null;
	level: LogLevel | null;
	logger: string | null;
	fields: LogField[];
}

const exec = (pattern: RegExp, text: string, at: number) => {
	pattern.lastIndex = at;
	return pattern.exec(text);
};

/**
 * What a text line prints before its message: a timestamp, a level, and the
 * process, thread or logger names loggers put around them, in any order.
 */
function readPrefix(text: string): Prefix {
	const start = text.length - text.trimStart().length;
	const prefix: Prefix = {
		end: start,
		stamp: null,
		date: null,
		level: null,
		logger: null,
		fields: [],
	};
	const body = start === 0 ? text : text.slice(start);

	const klog = KLOG_LINE.exec(body);
	if (klog) {
		prefix.level = KLOG_LEVELS[klog[1] ?? ""] ?? null;
		prefix.stamp = {
			printed: klog[2] ?? "",
			start: start + 1,
			end: start + 1 + (klog[2]?.length ?? 0),
		};
		prefix.logger = klog[4] ?? null;
		prefix.end = start + klog[0].length;
		return prefix;
	}
	const redis = REDIS_LINE.exec(body);
	if (redis) {
		const at = start + `${redis[1]}:${redis[2]} `.length;
		prefix.level = REDIS_LEVELS[redis[4] ?? ""] ?? null;
		prefix.stamp = {
			printed: redis[3] ?? "",
			start: at,
			end: at + (redis[3]?.length ?? 0),
		};
		prefix.fields.push({ key: "pid", value: redis[1] ?? "" });
		prefix.end = start + redis[0].length;
		return prefix;
	}
	const nest = NEST_LINE.exec(body);
	if (nest) {
		const at = start + body.indexOf(nest[2] ?? "");
		prefix.level = levelFromName(nest[3] ?? "");
		prefix.stamp = {
			printed: nest[2] ?? "",
			start: at,
			end: at + (nest[2]?.length ?? 0),
		};
		prefix.logger = nest[4] ?? null;
		prefix.fields.push({ key: "pid", value: nest[1] ?? "" });
		prefix.end = start + nest[0].length;
		return prefix;
	}

	let at = start;
	const readStamp = () => {
		const stamp = timestampAt(text, at);
		if (!stamp) return false;
		prefix.stamp = { printed: stamp.printed, start: at, end: stamp.end };
		prefix.date = stamp.date;
		at = skip(AFTER_TIMESTAMP, text, stamp.end);
		return true;
	};
	const readLevel = () => {
		const monolog = exec(AT_MONOLOG, text, at);
		if (monolog) {
			prefix.level = levelFromName(monolog[2] ?? "");
			prefix.logger = monolog[1] ?? null;
			at += monolog[0].length;
			return true;
		}
		const delimited = exec(AT_DELIMITED, text, at);
		const colon = delimited ? null : exec(AT_COLON, text, at);
		// `Error: boom` and `panic: …` are how a thrown error and a Go panic
		// print, not a logger's level.
		const thrown =
			(colon?.[1] === "Error" || colon?.[1] === "panic") &&
			prefix.stamp === null;
		const match =
			delimited ??
			(thrown ? null : colon) ??
			exec(AT_UPPER, text, at) ??
			(prefix.stamp ? exec(AT_BARE, text, at) : null);
		const level = match?.[1] ? levelFromName(match[1]) : null;
		if (!match || !level) return false;
		prefix.level = level;
		at += match[0].length;
		if (match === colon) {
			// Python's default format: `WARNING:urllib3.connectionpool:Retrying`.
			const logger = exec(AT_PYTHON_BASIC, text, at);
			if (logger) {
				prefix.logger = logger[1] ?? null;
				at += logger[0].length;
			}
		}
		at = skip(AFTER_LEVEL, text, at);
		return true;
	};

	readStamp();
	if (!readLevel()) {
		// A process id, a thread or a logger name between the two.
		const saved = at;
		const fields: LogField[] = [];
		let logger: string | null = null;
		const python = exec(AT_PYTHON_LOGGER, text, at);
		if (python) {
			logger = python[1] ?? null;
			at += python[0].length;
		} else {
			for (let count = 0; count < 2; count++) {
				const group = exec(AT_GROUP, text, at);
				if (!group?.[1]) break;
				// `[error]` is the level itself.
				if (levelFromName(group[1].trim())) break;
				fields.push({
					key: /^\d+$/.test(group[1]) ? "pid" : "thread",
					value: group[1],
				});
				at += group[0].length;
			}
		}
		if ((logger !== null || fields.length > 0) && readLevel()) {
			prefix.logger ??= logger;
			prefix.fields.push(...fields);
		} else {
			at = saved;
		}
	}
	if (prefix.level !== null) {
		if (prefix.stamp === null) readStamp();
		const spring = exec(AT_SPRING, text, at);
		const pid = spring
			? null
			: (exec(AT_NGINX_PID, text, at) ?? exec(AT_PID_GROUP, text, at));
		if (spring) {
			prefix.fields.push(
				{ key: "pid", value: spring[1] ?? "" },
				{ key: "thread", value: spring[2] ?? "" },
			);
			prefix.logger = spring[3] ?? null;
			at += spring[0].length;
		} else if (pid) {
			prefix.fields.push({ key: "pid", value: pid[1] ?? "" });
			at += pid[0].length;
		}
		if (prefix.logger === null) {
			const logger =
				exec(AT_LOGGER_GROUP, text, at) ??
				exec(AT_LOGURU, text, at) ??
				exec(AT_DOTTED_LOGGER, text, at);
			if (logger) {
				prefix.logger = logger[1] ?? null;
				at += logger[0].length;
			}
		}
	}
	prefix.end = at;
	return prefix;
}

/** `raw` from the character that is `offset` characters into its text
    without colour codes. */
function sliceRaw(raw: string, offset: number): string {
	if (!raw.includes(ESC)) return raw.slice(offset);
	let seen = 0;
	let index = 0;
	const ansi = new RegExp(ANSI.source, "y");
	while (index < raw.length && seen < offset) {
		ansi.lastIndex = index;
		const code = ansi.exec(raw);
		if (code) index += code[0].length;
		else {
			index++;
			seen++;
		}
	}
	return raw.slice(index);
}

/** The level a plain-text line declares about itself, or null. */
export function detectTextLevel(text: string): LogLevel | null {
	// BuildKit numbers every line of a step: `#8 6.120 npm warn deprecated …`.
	const trimmed = text.trimStart().replace(BUILDKIT_STEP, "");
	const keyValue = KEY_VALUE_LEVEL.exec(trimmed);
	if (keyValue?.[2]) {
		const level = levelFromName(keyValue[2]);
		if (level) return level;
	}
	const klog = KLOG.exec(trimmed);
	if (klog?.[1]) return KLOG_LEVELS[klog[1]] ?? null;
	const redis = REDIS.exec(trimmed);
	if (redis?.[1]) return REDIS_LEVELS[redis[1]] ?? null;

	const body = splitAppTimestamp(trimmed)?.rest ?? trimmed;
	const leading =
		LEADING_DELIMITED.exec(body) ??
		LEADING_COLON.exec(body) ??
		LEADING_UPPER.exec(body) ??
		LEADING_BARE.exec(body);
	if (leading?.[1]) return levelFromName(leading[1]);
	if (/^npm (?:ERR!|error)/.test(body)) return "error";
	if (/^npm (?:WARN|warn)\b/.test(body)) return "warn";

	const head = body.slice(0, HEAD_LENGTH);
	const delimited = HEAD_DELIMITED.exec(head);
	if (delimited?.[1]) return levelFromName(delimited[1]);
	const upper = HEAD_UPPER.exec(head);
	if (upper?.[1]) return levelFromName(upper[1]);
	const diagnostic = DIAGNOSTIC.exec(body);
	if (diagnostic?.[1]) return diagnostic[1] === "warning" ? "warn" : "error";
	if (THROWN.test(body) || BUILD_FAILURE.test(body)) return "error";
	if (/^\s*(?:❌|✖|✗)|❌\s*$/u.test(body)) return "error";
	// The line a build tool points at: ` > 12 | RUN npm run build`.
	if (/^>\s*\d+\s*\|/.test(body)) return "error";
	if (/^\s*⚠/u.test(body)) return "warn";
	return null;
}

const METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE";
const COMBINED_ACCESS = new RegExp(
	String.raw`^(\S+) \S+ (\S+) \[([^\]]+)\] "(${METHODS}) (\S+)(?: HTTP/[\d.]+)?" (\d{3}) (\d+|-)(?: "([^"]*)" "([^"]*)")?`,
);
const QUOTED_REQUEST = new RegExp(
	String.raw`"(${METHODS}) (\S+)(?: HTTP/[\d.]+)?" (\d{3})\b`,
);
const BARE_REQUEST = new RegExp(
	String.raw`(?:^|\s)(${METHODS}) (/\S*) (\d{3})\b`,
);

interface AccessLine {
	status: number;
	fields: LogField[];
	/** A whole combined line: the request can stand for it. */
	request: string | null;
	stamp: string | null;
}

function parseAccessLine(text: string): AccessLine | null {
	const combined = COMBINED_ACCESS.exec(text);
	if (combined) {
		const [
			,
			client,
			user,
			stamp,
			method,
			path,
			status,
			bytes,
			referrer,
			agent,
		] = combined;
		const fields: LogField[] = [
			{ key: "method", value: method ?? "" },
			{ key: "path", value: path ?? "" },
			{ key: "status", value: status ?? "" },
			{ key: "client", value: client ?? "" },
		];
		if (user && user !== "-") fields.push({ key: "user", value: user });
		if (bytes && bytes !== "-") fields.push({ key: "bytes", value: bytes });
		if (referrer && referrer !== "-") {
			fields.push({ key: "referrer", value: referrer });
		}
		if (agent && agent !== "-") {
			fields.push({ key: "user_agent", value: agent });
		}
		return {
			status: Number(status),
			fields,
			request: `${method} ${path} ${status}`,
			stamp: stamp ?? null,
		};
	}
	const request = QUOTED_REQUEST.exec(text) ?? BARE_REQUEST.exec(text);
	if (!request) return null;
	return {
		request: null,
		stamp: null,
		status: Number(request[3]),
		fields: [
			{ key: "method", value: request[1] ?? "" },
			{ key: "path", value: request[2] ?? "" },
			{ key: "status", value: request[3] ?? "" },
		],
	};
}

const LEVEL_KEYS = [
	"level",
	"severity",
	"lvl",
	"levelname",
	"log.level",
	"loglevel",
	"log_level",
	"level_name",
	"severity_text",
	"@l",
];
const MESSAGE_KEYS = [
	"msg",
	"message",
	"event",
	"text",
	"log",
	"short_message",
	"@m",
	"MESSAGE",
];
const ERROR_KEYS = [
	"error",
	"err",
	"err.message",
	"error.message",
	"exception.message",
];
const TIME_KEYS = ["time", "timestamp", "ts", "@timestamp", "t", "datetime"];
const METHOD_KEYS = [
	"method",
	"req.method",
	"request.method",
	"http_method",
	"request_method",
	"RequestMethod",
];
const PATH_KEYS = [
	"path",
	"url",
	"uri",
	"req.url",
	"request.url",
	"request.uri",
	"request.path",
	"request_uri",
	"RequestPath",
];
const DURATION_KEYS = [
	"duration",
	"duration_ms",
	"duration_s",
	"elapsed",
	"latency",
	"responseTime",
	"response_time",
	"took",
	"Duration",
];
const STATUS_KEYS = [
	"status",
	"statusCode",
	"status_code",
	"res.statusCode",
	"response.status",
	"http_status",
	"DownstreamStatus",
];

const MAX_STRUCTURED_LENGTH = 64 * 1024;
const MAX_FLATTEN_DEPTH = 2;

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return String(value);
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function flatten(
	value: Record<string, unknown>,
	prefix: string,
	depth: number,
	out: Map<string, unknown>,
) {
	for (const [key, item] of Object.entries(value)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (
			item !== null &&
			typeof item === "object" &&
			!Array.isArray(item) &&
			depth < MAX_FLATTEN_DEPTH &&
			Object.keys(item).length > 0
		) {
			flatten(item as Record<string, unknown>, path, depth + 1, out);
		} else {
			out.set(path, item);
		}
	}
}

const pick = (values: Map<string, unknown>, keys: readonly string[]) => {
	for (const key of keys) {
		const value = values.get(key);
		if (value !== undefined && value !== null && value !== "") {
			return { key, value };
		}
	}
	return null;
};

function timeFromValue(value: unknown): Date | null {
	let date: Date | null = null;
	if (typeof value === "number") {
		// Seconds, milliseconds or nanoseconds since the epoch.
		const ms = value > 1e17 ? value / 1e6 : value > 1e11 ? value : value * 1000;
		date = new Date(ms);
	} else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
		date = new Date(value);
	}
	return date && !Number.isNaN(date.getTime()) ? date : null;
}

const summary = (fields: readonly LogField[]) =>
	fields
		.filter((field) => !TIME_KEYS.includes(field.key))
		.slice(0, 8)
		.map(({ key, value }) => `${key}=${value}`)
		.join(" ");

interface Structured {
	format: LogFormat;
	level: LogLevel | null;
	message: string;
	fields: LogField[];
	time: Date | null;
}

/** The response status in a request's fields, or `fallback`. */
function statusOf(values: Map<string, unknown>, fallback: number | null) {
	if (!pick(values, METHOD_KEYS) && !pick(values, PATH_KEYS)) return fallback;
	const status = Number(pick(values, STATUS_KEYS)?.value);
	return Number.isFinite(status) ? status : fallback;
}

function fromValues(
	format: LogFormat,
	values: Map<string, unknown>,
): Structured {
	const levelValue = pick(values, LEVEL_KEYS);
	let level: LogLevel | null = null;
	if (levelValue) {
		level =
			typeof levelValue.value === "number"
				? levelFromNumber(levelValue.value)
				: /^\d+$/.test(String(levelValue.value))
					? levelFromNumber(Number(levelValue.value))
					: levelFromName(String(levelValue.value));
	}
	const messageValue =
		pick(values, MESSAGE_KEYS) ??
		(() => {
			const error = pick(values, ERROR_KEYS);
			return error && typeof error.value === "string" ? error : null;
		})();
	const method = pick(values, METHOD_KEYS);
	const path = pick(values, PATH_KEYS);
	const statusValue = method || path ? pick(values, STATUS_KEYS) : null;
	const status = statusValue ? Number(statusValue.value) : null;
	level = raiseForStatus(level, Number.isFinite(status) ? status : null);

	const fields: LogField[] = [];
	for (const [key, value] of values) {
		if (key === messageValue?.key || key === levelValue?.key) continue;
		fields.push({ key, value: stringify(value) });
	}
	let message: string;
	if (messageValue && typeof messageValue.value !== "object") {
		message = String(messageValue.value);
	} else if (method && path) {
		message = [method.value, path.value, statusValue?.value]
			.filter((part) => part !== undefined)
			.join(" ");
	} else {
		message = summary(fields);
	}
	const timeValue = pick(values, TIME_KEYS);
	return {
		format,
		level,
		message,
		fields,
		time: timeValue ? timeFromValue(timeValue.value) : null,
	};
}

function parseJson(text: string): Structured | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
	let value: unknown;
	try {
		value = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const values = new Map<string, unknown>();
	flatten(value as Record<string, unknown>, "", 0, values);
	if (values.size === 0) return null;
	return fromValues("json", values);
}

const MAX_OBJECT_STARTS = 4;

/** A JSON object that ends the text, as zap's console output and Caddy print
    their fields: `handled request {"status": 200}`. */
function trailingObject(
	text: string,
): { start: number; values: Map<string, unknown> } | null {
	const trimmed = text.trimEnd();
	if (!trimmed.endsWith("}")) return null;
	let start = trimmed.indexOf("{");
	for (let tries = 0; start > 0 && tries < MAX_OBJECT_STARTS; tries++) {
		const before = trimmed[start - 1];
		if (before === " " || before === "\t") {
			try {
				const value: unknown = JSON.parse(trimmed.slice(start));
				if (value !== null && typeof value === "object") {
					const values = new Map<string, unknown>();
					flatten(value as Record<string, unknown>, "", 0, values);
					return values.size > 0 ? { start, values } : null;
				}
			} catch {}
		}
		start = trimmed.indexOf("{", start + 1);
	}
	return null;
}

// zap's console output separates its columns with tabs:
// `logger <tab> caller <tab> message`.
const TAB_NAME = /^[\w.$/-]+(?::\d+)?$/;

const LOGFMT_PAIR = /([A-Za-z_@][\w.@/-]*)=(?:"((?:[^"\\]|\\.)*)"|(\S*))/g;

function parseLogfmt(text: string): Structured | null {
	if (!text.includes("=")) return null;
	const values = new Map<string, unknown>();
	let leftover = "";
	let last = 0;
	for (const match of text.matchAll(LOGFMT_PAIR)) {
		leftover += text.slice(last, match.index);
		last = match.index + match[0].length;
		const quoted = match[2];
		values.set(
			match[1] ?? "",
			quoted !== undefined
				? quoted.replace(/\\(["\\])/g, "$1")
				: (match[3] ?? ""),
		);
	}
	leftover += text.slice(last);
	if (leftover.trim() !== "" || values.size < 2) return null;
	const named = [...LEVEL_KEYS, ...MESSAGE_KEYS].some((key) => values.has(key));
	if (!named && values.size < 3) return null;
	return fromValues("logfmt", values);
}

const WEAK_ERROR =
	/\b(?:error|errors|failed|failure|exception|fatal|panic|denied|refused|unreachable|timed out)\b/i;

const FILE_HEADER = /^==> (.+) <==$/;
const RULED_TITLE = /^[=─━-]{3,}\s*([^\s=─━-].*?)\s*[=─━-]{3,}$/;
const STEP_TITLE = /^(?:──+|━━+|==>|#{2,})\s+(\S.*?)(?:\s+[─━]+)?$/;

function sectionTitle(text: string): string | null {
	const trimmed = text.trim();
	return (
		RULED_TITLE.exec(trimmed)?.[1] ?? STEP_TITLE.exec(trimmed)?.[1] ?? null
	);
}

const FRAME =
	/^\s+at\s+\S|^\s+File ".+", line \d+|^\s*\.{3} \d+ (?:more|common frames omitted)|^Caused by: |^\s*Suppressed: |^\s+[\^~]+\s*$/;
const STATEMENT_DETAIL =
	/^(?:\[\d+\]:? )?(?:STATEMENT|DETAIL|HINT|CONTEXT|QUERY|LOCATION):\s/;
const QUALIFIED_THROWABLE =
	/^(?:[a-z_][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error|Throwable)\b/;
const PYTHON_HEADER = /^Traceback \(most recent call last\):/;
// Lines of one report are printed together; further apart they are two.
const TOGETHER_MS = 1000;
const PYTHON_CHAIN =
	/^(?:During handling of the above exception|The above exception was the direct cause)/;
const GO_HEADER = /^(?:panic: |fatal error: |goroutine \d+ \[)/;
const GO_FRAME =
	/^(?:goroutine \d+ \[.*\]:|\t.+|[\w./*()[\]{}·$-]+\(.*\)|created by .+|\[signal .*|panic: .*|exit status \d+)$/;

export interface ParsedLine {
	/** `file` is the header `tail` prints before lines of another file. */
	kind: "entry" | "section" | "file" | "blank";
	timestamp: Date | null;
	rawTimestamp: string | null;
	source: string | null;
	level: LogLevel | null;
	message: string;
	logger: string | null;
	appTimestamp: string | null;
	raw: string;
	text: string;
	format: LogFormat;
	fields: LogField[];
	/** How the line could continue the entry above it. */
	continues: "frame" | "detail" | "indented" | null;
}

export interface ParseOptions {
	stream?: LogStream;
	/** The line has a time from elsewhere (when it was received), so its own
	    timestamp need not stay in the message. */
	timed?: boolean;
}

/** Reads one line of output. Pure: the same line always gives the same result. */
export function parseLine(
	line: string,
	options: ParseOptions = {},
): ParsedLine {
	const { stream, timed = false } = options;
	let rest = line.endsWith("\r") ? line.slice(0, -1) : line;
	// A carriage return redraws the line; what was printed last is what shows.
	if (rest.includes("\r")) {
		rest =
			rest
				.split("\r")
				.filter((part) => part.trim() !== "")
				.pop() ?? "";
	}
	let timestamp: Date | null = null;
	let rawTimestamp: string | null = null;
	const runtime = RUNTIME_TIMESTAMP.exec(rest);
	if (runtime?.[1]) {
		const parsed = new Date(
			// Date keeps milliseconds; Docker prints nanoseconds.
			runtime[1].replace(/(\.\d{3})\d+/, "$1"),
		);
		if (!Number.isNaN(parsed.getTime())) {
			timestamp = parsed;
			rawTimestamp = runtime[1];
			rest = rest.slice(runtime[0].length);
		}
	}
	let source: string | null = null;
	const prefixed = SOURCE_PREFIX.exec(stripAnsi(rest));
	if (prefixed?.[1] && rest.startsWith(prefixed[0])) {
		source = prefixed[1];
		rest = rest.slice(prefixed[0].length);
	}
	const raw = rest;
	const text = stripAnsi(raw);
	const base = {
		timestamp,
		rawTimestamp,
		source,
		raw,
		text,
		logger: null,
		appTimestamp: null,
		fields: [] as LogField[],
		format: "text" as LogFormat,
		continues: null,
	};
	if (text.trim() === "") {
		return { ...base, kind: "blank", level: null, message: "" };
	}
	const file = FILE_HEADER.exec(text.trim())?.[1];
	if (file !== undefined) {
		return { ...base, kind: "file", level: null, message: file };
	}
	const title = sectionTitle(text);
	if (title !== null) {
		return { ...base, kind: "section", level: null, message: title };
	}

	const structured =
		text.length <= MAX_STRUCTURED_LENGTH
			? (parseJson(text) ?? parseLogfmt(text.trim()))
			: null;
	if (structured) {
		return {
			...base,
			kind: "entry",
			timestamp: timestamp ?? structured.time,
			level: structured.level,
			message: structured.message,
			format: structured.format,
			fields: structured.fields,
		};
	}

	const continues = FRAME.test(text)
		? ("frame" as const)
		: STATEMENT_DETAIL.test(splitAppTimestamp(text)?.rest ?? text)
			? ("detail" as const)
			: // One space is how Docker prints progress, not a continuation.
				/^(?:\t| [ \t])[ \t]*\S/.test(text)
				? ("indented" as const)
				: null;
	const prefix = readPrefix(text);
	const access = parseAccessLine(text);
	let level = raiseForStatus(
		prefix.level ?? detectTextLevel(text),
		access?.status ?? null,
	);
	if (level === null && stream === "stderr" && WEAK_ERROR.test(text)) {
		level = "error";
	}
	if (timestamp === null) timestamp = prefix.date;
	const hasTime = timed || timestamp !== null;
	const entry = {
		...base,
		kind: "entry" as const,
		timestamp,
		level,
		logger: prefix.logger,
		continues,
	};
	if (access?.request) {
		return {
			...entry,
			timestamp: timestamp ?? (access.stamp ? accessDate(access.stamp) : null),
			message: access.request,
			appTimestamp: access.stamp,
			format: "access",
			fields: access.fields,
		};
	}

	const recognised = prefix.stamp !== null || prefix.level !== null;
	if (!recognised || text.slice(prefix.end).trim() === "") {
		const object =
			text.length <= MAX_STRUCTURED_LENGTH ? trailingObject(text) : null;
		if (object) {
			const data = mixed(object.values, level, access?.status ?? null);
			return {
				...entry,
				...data,
				timestamp: timestamp ?? data.timestamp,
				message: text.slice(0, object.start).trim().replace(/\s*:$/, ""),
			};
		}
		return {
			...entry,
			// Docker indents its progress lines by one space; that is not structure.
			message: /^ \S/.test(raw) ? raw.slice(1) : raw,
			fields: access?.fields ?? [],
		};
	}

	// With the time and the level in their own columns, the copies the
	// program printed only push the message off the row.
	const said = text.slice(prefix.end);
	const stamp = prefix.stamp;
	// Without a time of our own the printed one is all the row has.
	const lead = stamp && !hasTime ? `${stamp.printed} ` : "";
	const appTimestamp = stamp && hasTime ? stamp.printed : null;
	const short = text.length <= MAX_STRUCTURED_LENGTH;

	const whole = short ? parseJson(said) : null;
	if (whole) {
		return {
			...entry,
			timestamp: timestamp ?? whole.time,
			level: level ?? whole.level,
			appTimestamp,
			message: lead + whole.message,
			format: "mixed",
			fields: [...prefix.fields, ...whole.fields],
		};
	}
	const object = short ? trailingObject(said) : null;
	const head = object ? said.slice(0, object.start) : said;
	let logger = prefix.logger;
	let message: string | null = null;
	const fields = [...prefix.fields];
	if (head.includes("\t")) {
		const columns = head.split("\t").filter((column) => column.trim() !== "");
		const names: string[] = [];
		while (columns.length > 1 && TAB_NAME.test(columns[0] ?? "")) {
			names.push(columns.shift() ?? "");
		}
		if (names.length > 0) {
			const caller = logger === null ? names.slice(1) : names;
			logger ??= names[0] ?? null;
			if (caller.length > 0) {
				fields.push({ key: "caller", value: caller.join(" ") });
			}
			message = columns.join("  ");
		}
	}
	if (object) {
		const data = mixed(object.values, level, access?.status ?? null);
		return {
			...entry,
			...data,
			timestamp: timestamp ?? data.timestamp,
			logger,
			appTimestamp,
			message: lead + (message ?? head).trim().replace(/\s*:$/, ""),
			fields: [...fields, ...data.fields],
		};
	}
	return {
		...entry,
		logger,
		appTimestamp,
		message: lead + (message ?? sliceRaw(raw, prefix.end)),
		fields: [...fields, ...(access?.fields ?? [])],
	};
}

/** The fields of a JSON object that ends a line of text. */
function mixed(
	values: Map<string, unknown>,
	level: LogLevel | null,
	status: number | null,
) {
	const data = fromValues("mixed", values);
	return {
		format: "mixed" as const,
		timestamp: data.time,
		level: raiseForStatus(level ?? data.level, statusOf(values, status)),
		fields: [...values].map(([key, value]) => ({
			key,
			value: stringify(value),
		})),
	};
}

type Mode = null | "python" | "python-tail" | "go";

interface Provisional {
	count: number;
	nextId: number;
	mode: Mode;
	sealed: boolean;
	boundary: boolean;
	files: Map<string, string>;
	sources: number;
	last: Pick<LogEntry, "message" | "level" | "attached"> | null;
}

/** Text from `offset` on arrived at `at` (milliseconds). */
export interface TimeMark {
	offset: number;
	at: number;
}

export const DEFAULT_MAX_ENTRIES = 50_000;

const entryFrom = (
	id: number,
	parsed: ParsedLine,
	stream: LogStream | null,
	file: string | null,
	at: Date | null,
): LogEntry => ({
	id,
	kind: parsed.kind === "section" ? "section" : "entry",
	timestamp: parsed.timestamp ?? at,
	rawTimestamp: parsed.rawTimestamp,
	level: parsed.level,
	source:
		file === null
			? parsed.source
			: parsed.source === null
				? file
				: `${parsed.source}:${file}`,
	file,
	stream,
	message: parsed.message.trimEnd(),
	logger: parsed.logger,
	appTimestamp: parsed.appTimestamp,
	raw: parsed.raw,
	text: parsed.text,
	format: parsed.format,
	fields: parsed.fields,
	attached: [],
});

/**
 * Turns output into entries as it arrives. Each line is read once; a line that
 * continues the entry above it (a stack frame, a statement detail) is attached
 * to that entry instead of becoming a row, and the header `tail` prints when
 * it follows several files names the source of the lines after it.
 */
export class LogBuffer {
	entries: LogEntry[] = [];
	/** Every source seen, in the order they first printed. */
	sources: string[] = [];
	private nextId = 1;
	private partial = "";
	private mode: Mode = null;
	private consumed = "";
	private provisional: Provisional | null = null;
	// A blank line ends a record: what is indented after it starts over.
	private sealed = false;
	// The file being tailed changed: the next line continues nothing.
	private boundary = false;
	// The file each container is printing from, by its prefix ("" without one).
	private files = new Map<string, string>();
	// When the line before this one was printed, where that is known.
	private lastTime: number | null = null;
	private readonly maxEntries: number;

	constructor(options: { maxEntries?: number } = {}) {
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
	}

	get lastId(): number {
		return this.nextId - 1;
	}

	clear() {
		this.entries = [];
		this.sources = [];
		this.partial = "";
		this.mode = null;
		this.consumed = "";
		this.provisional = null;
		this.sealed = false;
		this.boundary = false;
		this.files.clear();
		this.lastTime = null;
	}

	/** Appends a piece of a stream; a line cut by the chunk waits for its end. */
	push(chunk: string, stream?: LogStream) {
		const text = this.partial + chunk;
		const lines = text.split("\n");
		this.partial = lines.pop() ?? "";
		for (const line of lines) this.add(line, stream);
		this.trim();
	}

	/** Reads the unfinished last line as it stands. */
	end(stream?: LogStream) {
		if (this.partial === "") return;
		const line = this.partial;
		this.partial = "";
		this.add(line, stream);
	}

	/**
	 * For output that is re-read whole as it grows (a job's log): only the new
	 * tail is parsed. A last line without its newline shows as it is and is
	 * read again once more of it arrives. `marks` say when each stretch of the
	 * text arrived: a line that prints no time of its own takes that one.
	 */
	setText(text: string, marks?: readonly TimeMark[]) {
		if (!text.startsWith(this.consumed)) this.clear();
		this.rollback();
		const fresh = text.slice(this.consumed.length);
		const end = fresh.lastIndexOf("\n") + 1;
		let offset = this.consumed.length;
		let mark = 0;
		const arrived = () => {
			if (!marks || marks.length === 0) return undefined;
			while (
				mark + 1 < marks.length &&
				(marks[mark + 1] as TimeMark).offset <= offset
			) {
				mark++;
			}
			const current = marks[mark] as TimeMark;
			return current.offset <= offset ? new Date(current.at) : undefined;
		};
		if (end > 0) {
			for (const line of fresh.slice(0, end - 1).split("\n")) {
				this.add(line, undefined, arrived());
				offset += line.length + 1;
			}
			this.consumed = text.slice(0, this.consumed.length + end);
		}
		const tail = fresh.slice(end);
		if (tail !== "") {
			const last = this.entries.at(-1);
			this.provisional = {
				count: this.entries.length,
				nextId: this.nextId,
				mode: this.mode,
				sealed: this.sealed,
				boundary: this.boundary,
				files: new Map(this.files),
				sources: this.sources.length,
				last: last
					? {
							message: last.message,
							level: last.level,
							attached: [...last.attached],
						}
					: null,
			};
			this.add(tail, undefined, arrived());
		}
	}

	private rollback() {
		const saved = this.provisional;
		if (!saved) return;
		this.provisional = null;
		this.entries.length = saved.count;
		this.nextId = saved.nextId;
		this.mode = saved.mode;
		this.sealed = saved.sealed;
		this.boundary = saved.boundary;
		this.files = saved.files;
		this.sources.length = saved.sources;
		const last = this.entries.at(-1);
		if (last && saved.last) Object.assign(last, saved.last);
	}

	private trim() {
		// Dropping in batches keeps a steady stream from shifting the array on
		// every line.
		const slack = Math.max(1, Math.floor(this.maxEntries / 10));
		if (this.entries.length > this.maxEntries + slack) {
			this.entries.splice(0, this.entries.length - this.maxEntries);
		}
	}

	private attach(entry: LogEntry, line: ParsedLine) {
		entry.attached.push(line.raw);
	}

	private add(line: string, stream?: LogStream, at?: Date) {
		const parsed = parseLine(line, { stream, timed: at !== undefined });
		const last = this.entries.at(-1);
		const open = last && last.kind === "entry" && !this.boundary ? last : null;
		// Whether this line was printed with the one before it. Lines without
		// a time (a pasted log) are taken to be.
		const time = parsed.timestamp?.getTime() ?? at?.getTime() ?? null;
		const together =
			time === null ||
			this.lastTime === null ||
			Math.abs(time - this.lastTime) <= TOGETHER_MS;
		if (time !== null && parsed.kind !== "blank") this.lastTime = time;

		if (parsed.kind === "blank") {
			// Tracebacks and goroutine dumps carry blank lines of their own.
			if (this.mode === null) this.sealed = true;
			return;
		}
		if (parsed.kind === "file") {
			const key = parsed.source ?? "";
			// `tail` repeats the header when it returns to a file.
			if (this.files.get(key) === parsed.message) return;
			this.files.set(key, parsed.message);
			this.boundary = true;
			this.mode = null;
			return;
		}

		if (open && this.mode === "python") {
			if (/^[ \t]/.test(parsed.text) || PYTHON_HEADER.test(parsed.text)) {
				this.attach(open, parsed);
				return;
			}
			if (PYTHON_CHAIN.test(parsed.text)) {
				this.attach(open, parsed);
				return;
			}
			// The first line back at the margin names the exception.
			this.attach(open, parsed);
			if (PYTHON_HEADER.test(stripAnsi(open.message))) {
				open.message = parsed.raw;
			}
			this.mode = "python-tail";
			return;
		}
		if (open && this.mode === "python-tail") {
			// "During handling of the above exception…" joins the next
			// traceback to this one. A traceback that follows without it is
			// another failure, and an entry of its own.
			if (PYTHON_CHAIN.test(parsed.text)) {
				this.attach(open, parsed);
				this.mode = "python";
				return;
			}
			this.mode = null;
		}
		if (open && this.mode === "go") {
			if (GO_FRAME.test(parsed.text)) {
				this.attach(open, parsed);
				return;
			}
			this.mode = null;
		}

		if (open && parsed.kind === "entry") {
			// A traceback goes under the error line that reports it
			// (logger.exception): printed in the same moment, and only while
			// that line has no trace of its own yet. An error from a while ago,
			// or one that already carries its stack, is another failure.
			if (
				PYTHON_HEADER.test(parsed.text) &&
				open.level === "error" &&
				open.attached.length === 0 &&
				together
			) {
				this.attach(open, parsed);
				this.mode = "python";
				return;
			}
			if (parsed.continues === "frame") {
				this.attach(open, parsed);
				open.level ??= "error";
				return;
			}
			if (parsed.continues === "detail") {
				this.attach(open, parsed);
				return;
			}
			// A thrown exception is logged under the error that reports it.
			if (
				QUALIFIED_THROWABLE.test(parsed.text) &&
				open.level === "error" &&
				open.attached.length === 0
			) {
				this.attach(open, parsed);
				return;
			}
			// Loggers indent the lines that belong to a record; a program that
			// only prints (a banner, a build) indents freely, and those stay rows.
			if (
				parsed.continues === "indented" &&
				parsed.level === null &&
				!this.sealed &&
				(open.level !== null || open.attached.length > 0)
			) {
				this.attach(open, parsed);
				return;
			}
		}

		this.mode =
			parsed.kind !== "entry"
				? null
				: PYTHON_HEADER.test(parsed.text)
					? "python"
					: GO_HEADER.test(parsed.text)
						? "go"
						: null;
		this.sealed = false;
		this.boundary = false;
		const entry = entryFrom(
			this.nextId++,
			parsed,
			stream ?? null,
			parsed.kind === "entry"
				? (this.files.get(parsed.source ?? "") ?? null)
				: null,
			at ?? null,
		);
		if (entry.source !== null && !this.sources.includes(entry.source)) {
			this.sources.push(entry.source);
		}
		this.entries.push(entry);
	}
}

/** Entries of a complete piece of output. */
export function parseLogText(text: string): LogEntry[] {
	const buffer = new LogBuffer({ maxEntries: Number.POSITIVE_INFINITY });
	buffer.push(text);
	buffer.end();
	return buffer.entries;
}

/** One entry per line, nothing attached: for short tails that show raw lines. */
export function parseLogLines(text: string): LogEntry[] {
	const entries: LogEntry[] = [];
	let id = 1;
	let file: string | null = null;
	for (const line of text.split("\n")) {
		const parsed = parseLine(line);
		if (parsed.kind === "blank") continue;
		if (parsed.kind === "file") {
			file = parsed.message;
			continue;
		}
		entries.push(entryFrom(id++, parsed, null, file, null));
	}
	return entries;
}

/** An entry as text, the way it was printed. */
export function entryText(
	entry: LogEntry,
	options: { timestamps?: boolean } = {},
): string {
	const head =
		options.timestamps !== false && entry.rawTimestamp
			? `${entry.rawTimestamp} ${entry.text}`
			: entry.text;
	if (entry.attached.length === 0) return head;
	return `${head}\n${entry.attached.map(stripAnsi).join("\n")}`;
}

export type LevelFilter = Exclude<LogLevel, "trace"> | "other";

/** What the level filter calls an entry: trace reads with debug. */
export const levelBucket = (level: LogLevel | null): LevelFilter =>
	level === null ? "other" : level === "trace" ? "debug" : level;

export interface EntryFilter {
	levels?: ReadonlySet<LevelFilter>;
	sources?: ReadonlySet<string>;
	search?: string;
}

const escapeRegExp = (value: string) =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function searchPattern(search: string): RegExp | null {
	const needle = search.trim();
	return needle ? new RegExp(escapeRegExp(needle), "i") : null;
}

export function filterEntries(
	entries: readonly LogEntry[],
	filter: EntryFilter,
): LogEntry[] {
	const pattern = searchPattern(filter.search ?? "");
	const levels = filter.levels && filter.levels.size > 0 ? filter.levels : null;
	const sources =
		filter.sources && filter.sources.size > 0 ? filter.sources : null;
	return entries.filter((entry) => {
		if (levels) {
			if (entry.kind === "section") return false;
			if (!levels.has(levelBucket(entry.level))) return false;
		}
		if (sources) {
			if (entry.source === null || !sources.has(entry.source)) return false;
		}
		if (!pattern) return true;
		if (pattern.test(entry.text)) return true;
		return entry.attached.some((line) => pattern.test(line));
	});
}

/**
 * Entries as text, the way they were printed. Lines of several tailed files
 * get back the header that named their file.
 */
export function entriesText(
	entries: readonly LogEntry[],
	options: { timestamps?: boolean } = {},
): string {
	const lines: string[] = [];
	let file: string | null = null;
	for (const entry of entries) {
		if (entry.file !== null && entry.file !== file) {
			if (lines.length > 0) lines.push("");
			lines.push(`==> ${entry.file} <==`);
		}
		if (entry.kind === "entry") file = entry.file;
		lines.push(entryText(entry, options));
	}
	return lines.join("\n");
}

const GENERIC_FILES = new Set(["current", "log", "output", "out"]);
const GENERIC_DIRECTORIES = new Set(["log", "logs", "var", "tmp", "data"]);

function fileLabel(path: string, depth: number): string {
	const parts = path.split("/").filter(Boolean);
	const base = (parts.pop() ?? path).replace(/\.(?:log|txt|out)$/, "");
	if (GENERIC_FILES.has(base) && parts.length > 0) {
		return parts.slice(-depth).join("/");
	}
	const parent = parts
		.slice(-depth)
		.filter(
			(part, index, all) =>
				index < all.length - 1 || !GENERIC_DIRECTORIES.has(part),
		);
	return [...parent, base].join("/");
}

/**
 * A short name for each source: `nginx/gitlab_access` for
 * `/var/log/gitlab/nginx/gitlab_access.log`, `gitaly` for `…/gitaly/current`.
 * Two files that would share a name keep one more directory.
 */
export function sourceLabels(sources: readonly string[]): Map<string, string> {
	const labels = new Map<string, string>();
	const label = (source: string, depth: number) => {
		const at = source.indexOf(":/");
		const container = at === -1 ? "" : `${source.slice(0, at)} `;
		const path = at === -1 ? source : source.slice(at + 1);
		return path.includes("/")
			? `${container}${fileLabel(path, depth)}`
			: source;
	};
	for (const source of sources) labels.set(source, label(source, 1));
	for (let depth = 2; depth <= 4; depth++) {
		const seen = new Map<string, number>();
		for (const value of labels.values()) {
			seen.set(value, (seen.get(value) ?? 0) + 1);
		}
		let clash = false;
		for (const [source, value] of labels) {
			if ((seen.get(value) ?? 0) < 2) continue;
			clash = true;
			labels.set(source, label(source, depth));
		}
		if (!clash) break;
	}
	return labels;
}

const HIDDEN_ROW_FIELDS = new Set([
	...TIME_KEYS,
	"pid",
	"hostname",
	"v",
	"thread",
	"caller",
]);
// Long ids say nothing at a glance; they are in the detail to filter by.
const OPAQUE_ID = /(?:^|[._])(?:correlation|request|trace|span)_?id$/i;
const shortKey = (key: string) => key.slice(key.lastIndexOf(".") + 1);

/** A length of time the way a person says it: `659 µs`, `12 ms`, `1.2 s`. */
export function formatSeconds(seconds: number): string {
	const short = (value: number) =>
		value >= 100 || Number.isInteger(value)
			? String(Math.round(value))
			: value.toPrecision(2).replace(/\.0$/, "");
	if (seconds < 0.001) return `${short(seconds * 1e6)} µs`;
	if (seconds < 1) return `${short(seconds * 1000)} ms`;
	if (seconds < 60) return `${short(seconds)} s`;
	return `${short(seconds / 60)} min`;
}

const SECONDS_KEY = /_(?:s|secs?|seconds)$/;
const MILLIS_KEY = /_(?:ms|millis)$|Ms$/;
// zap, Caddy and structlog write a duration as seconds with a long fraction.
const FRACTION_OF_SECONDS = /^\d+\.\d{4,}$/;

/** A duration for a row: in a unit that reads, when the field says which
    unit it is in. The value as logged stays in the entry's detail. */
function readableDuration(key: string, value: string): LogField {
	const amount = Number(value);
	if (value.trim() === "" || !Number.isFinite(amount) || amount < 0) {
		return { key, value };
	}
	if (SECONDS_KEY.test(key)) {
		return {
			key: key.replace(SECONDS_KEY, ""),
			value: formatSeconds(amount),
		};
	}
	if (MILLIS_KEY.test(key)) {
		return {
			key: key.replace(MILLIS_KEY, ""),
			value: formatSeconds(amount / 1000),
		};
	}
	return FRACTION_OF_SECONDS.test(value)
		? { key, value: formatSeconds(amount) }
		: { key, value };
}

/**
 * The few fields a row shows beside its message: for a request its method,
 * path, status and duration first, then the rest in the order logged. What
 * the message already says and values that are objects stay in the detail.
 */
export function rowFields(entry: LogEntry, limit: number): LogField[] {
	if (entry.format === "text" || entry.fields.length === 0) return [];
	const byKey = new Map(entry.fields.map((field) => [field.key, field]));
	const first = (keys: readonly string[]) => {
		for (const key of keys) {
			const field = byKey.get(key);
			if (field && field.value !== "") return field;
		}
		return null;
	};
	const message = ` ${stripAnsi(entry.message)} `;
	const chosen: LogField[] = [];
	const taken = new Set<string>();
	for (const keys of [METHOD_KEYS, PATH_KEYS, STATUS_KEYS, DURATION_KEYS]) {
		const field = first(keys);
		if (!field) continue;
		taken.add(field.key);
		if (message.includes(` ${field.value} `)) continue;
		const key = shortKey(field.key);
		chosen.push(
			keys === DURATION_KEYS
				? readableDuration(key, field.value)
				: { key, value: field.value },
		);
	}
	// A request reads whole from those four.
	if (taken.size >= 2) return chosen.slice(0, limit);
	for (const field of entry.fields) {
		if (chosen.length >= limit) break;
		if (taken.has(field.key) || HIDDEN_ROW_FIELDS.has(field.key)) continue;
		if (OPAQUE_ID.test(field.key)) continue;
		if (field.value === "" || /^[{[]/.test(field.value)) continue;
		chosen.push(field);
	}
	return chosen.slice(0, limit);
}

/**
 * The program's own timestamp, when it is worth showing beside ours: it says
 * another moment (more than `tolerance` away), or it can't be compared.
 */
export function differingAppTimestamp(
	entry: LogEntry,
	tolerance = 1500,
): string | null {
	const printed = entry.appTimestamp;
	if (printed === null) return null;
	if (entry.timestamp === null) return printed;
	const stamp = timestampAt(printed, 0);
	const ours = entry.timestamp.getTime();
	if (stamp?.date) {
		return Math.abs(stamp.date.getTime() - ours) > tolerance ? printed : null;
	}
	// Without a zone it is the same moment if it is ours in some time zone,
	// which are whole quarter hours apart.
	const quarter = 15 * 60_000;
	const clock = /(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/.exec(printed);
	if (!clock) return printed;
	const theirs =
		(Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])) *
			1000 +
		Number((clock[4] ?? "0").padEnd(3, "0"));
	const apart = (((theirs - ours) % quarter) + quarter) % quarter;
	return Math.min(apart, quarter - apart) > tolerance ? printed : null;
}

export interface EmbeddedJson {
	/** The text before and after the value. */
	before: string;
	after: string;
	value: unknown;
}

const MAX_JSON_STARTS = 8;

/**
 * The JSON object or array in a line: the whole line, the end of it (as Caddy
 * prints its fields), or a value somewhere inside. Null for a line too long
 * to be worth reading.
 */
export function findJson(text: string): EmbeddedJson | null {
	if (text.length > MAX_STRUCTURED_LENGTH) return null;
	const opener = /[{[]/g;
	for (let tries = 0; tries < MAX_JSON_STARTS; tries++) {
		const match = opener.exec(text);
		if (!match) return null;
		const start = match.index;
		const close = match[0] === "{" ? "}" : "]";
		let end = text.lastIndexOf(close);
		// Shrinks from the last closer: the value usually ends the line.
		for (let shrink = 0; end > start && shrink < 3; shrink++) {
			try {
				const value: unknown = JSON.parse(text.slice(start, end + 1));
				if (
					value !== null &&
					typeof value === "object" &&
					Object.keys(value).length > 0
				) {
					return {
						before: text.slice(0, start).trim(),
						after: text.slice(end + 1).trim(),
						value,
					};
				}
				break;
			} catch {
				end = text.lastIndexOf(close, end - 1);
			}
		}
	}
	return null;
}

/** A string that holds JSON (an object or an array), read one level deeper. */
export function nestedJson(value: string): unknown {
	const trimmed = value.trim();
	if (trimmed.length < 2 || trimmed.length > MAX_STRUCTURED_LENGTH) {
		return undefined;
	}
	const first = trimmed[0];
	const last = trimmed.at(-1);
	if (!((first === "{" && last === "}") || (first === "[" && last === "]"))) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return parsed !== null && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
}
