import assert from "node:assert/strict";
import { test } from "node:test";
import {
	detectTextLevel,
	differingAppTimestamp,
	entriesText,
	entryText,
	filterEntries,
	findJson,
	formatSeconds,
	LogBuffer,
	type LogEntry,
	levelBucket,
	nestedJson,
	parseLine,
	parseLogLines,
	parseLogText,
	rowFields,
	sourceLabels,
	stripAnsi,
} from "./log-entries.ts";

const T = "2026-11-21T10:15:42.123456789Z";
const stamped = (lines: string[]) =>
	lines.map((line) => `${T} ${line}`).join("\n");
const only = (text: string): LogEntry => {
	const entries = parseLogText(text);
	assert.equal(entries.length, 1, `expected one entry, got ${entries.length}`);
	return entries[0] as LogEntry;
};
const field = (entry: LogEntry, key: string) =>
	entry.fields.find((item) => item.key === key)?.value;

test("the runtime timestamp becomes the entry's time and leaves the line", () => {
	const entry = only(`${T} server listening on :3000`);
	assert.equal(entry.rawTimestamp, T);
	assert.equal(entry.timestamp?.toISOString(), "2026-11-21T10:15:42.123Z");
	assert.equal(entry.raw, "server listening on :3000");
	assert.equal(entry.message, "server listening on :3000");
	assert.equal(entry.level, null);
});

test("a timestamp with an offset is read too", () => {
	const entry = only("2026-11-21T15:45:42.5+05:30 ready");
	assert.equal(entry.timestamp?.toISOString(), "2026-11-21T10:15:42.500Z");
	assert.equal(entry.message, "ready");
});

test("GitLab JSON: severity, message and the remaining fields", () => {
	const entry = only(
		`${T} {"severity":"ERROR","time":"2026-11-21T10:15:42.120Z","correlation_id":"01JD3X","class":"Gitlab::Git::CommandError","message":"13:reading repository: exit status 128"}`,
	);
	assert.equal(entry.format, "json");
	assert.equal(entry.level, "error");
	assert.equal(entry.message, "13:reading repository: exit status 128");
	assert.equal(field(entry, "correlation_id"), "01JD3X");
	assert.equal(field(entry, "message"), undefined);
	assert.equal(field(entry, "severity"), undefined);
});

test("GitLab request JSON without a message reads as the request", () => {
	const entry = only(
		`${T} {"method":"GET","path":"/api/v4/projects","format":"json","status":502,"duration_s":30.01,"time":"2026-11-21T10:15:42.120Z"}`,
	);
	assert.equal(entry.message, "GET /api/v4/projects 502");
	assert.equal(entry.level, "error");
	assert.equal(field(entry, "duration_s"), "30.01");
});

test("pino: numeric levels, nested request fields, epoch time", () => {
	const line =
		'{"level":30,"time":1795256142123,"pid":18,"hostname":"api-1","req":{"method":"POST","url":"/orders"},"res":{"statusCode":201},"responseTime":12,"msg":"request completed"}';
	const entry = only(line);
	assert.equal(entry.level, "info");
	assert.equal(entry.message, "request completed");
	assert.equal(field(entry, "req.method"), "POST");
	assert.equal(field(entry, "res.statusCode"), "201");
	assert.equal(entry.timestamp?.getTime(), 1795256142123);
	for (const [level, expected] of [
		[10, "trace"],
		[20, "debug"],
		[40, "warn"],
		[50, "error"],
		[60, "error"],
	] as const) {
		assert.equal(only(`{"level":${level},"msg":"x"}`).level, expected);
	}
});

test("a response status raises an info line, never lowers an error", () => {
	assert.equal(
		only('{"level":"info","method":"GET","url":"/x","status":503,"msg":"done"}')
			.level,
		"error",
	);
	assert.equal(
		only('{"level":"info","method":"GET","url":"/x","status":404,"msg":"done"}')
			.level,
		"warn",
	);
	assert.equal(
		only(
			'{"level":"error","method":"GET","url":"/x","status":200,"msg":"done"}',
		).level,
		"error",
	);
	assert.equal(only('{"status":500,"msg":"queue depth"}').level, null);
});

test("other JSON level keys and syslog numbers", () => {
	assert.equal(only('{"lvl":"warn","msg":"x"}').level, "warn");
	assert.equal(only('{"levelname":"CRITICAL","message":"x"}').level, "error");
	assert.equal(only('{"log.level":"debug","message":"x"}').level, "debug");
	assert.equal(only('{"level":3,"short_message":"x"}').level, "error");
	assert.equal(only('{"level":6,"short_message":"x"}').level, "info");
});

test("JSON without a message shows its fields on one line", () => {
	const entry = only('{"user":"ada","action":"login","ok":true}');
	assert.equal(entry.message, "user=ada action=login ok=true");
	assert.equal(entry.level, null);
});

test("a line that only looks like JSON stays text", () => {
	const entry = only("{not json} ERROR broke");
	assert.equal(entry.format, "text");
	assert.equal(entry.level, "error");
});

test("Traefik logfmt", () => {
	const entry = only(
		`${T} time="2026-11-21T10:15:42Z" level=error msg="Unable to obtain ACME certificate for domains \\"app.example.test\\"" providerName=letsencrypt.acme routerName=app@docker`,
	);
	assert.equal(entry.format, "logfmt");
	assert.equal(entry.level, "error");
	assert.equal(
		entry.message,
		'Unable to obtain ACME certificate for domains "app.example.test"',
	);
	assert.equal(field(entry, "providerName"), "letsencrypt.acme");
});

test("Grafana logfmt: empty values and a request status", () => {
	const entry = only(
		'logger=context userId=0 orgId=0 uname= t=2026-11-21T10:15:42.12Z level=info msg="Request Completed" method=GET path=/api/live/ws status=500 remote_addr=10.0.1.7 duration=2.1ms',
	);
	assert.equal(entry.format, "logfmt");
	assert.equal(entry.message, "Request Completed");
	assert.equal(entry.level, "error");
	assert.equal(field(entry, "uname"), "");
	assert.equal(field(entry, "logger"), "context");
});

test("text with a key=value level is not mistaken for logfmt", () => {
	const entry = only("caddy run level=warn something happened here");
	assert.equal(entry.format, "text");
	assert.equal(entry.level, "warn");
});

test("nginx access lines: fields and a level from the status", () => {
	const ok = only(
		'203.0.113.9 - - [21/Nov/2026:10:15:42 +0000] "GET /assets/app.css HTTP/1.1" 200 5123 "https://app.example.test/" "Mozilla/5.0 (X11; Linux x86_64)"',
	);
	assert.equal(ok.level, "info");
	assert.equal(field(ok, "method"), "GET");
	assert.equal(field(ok, "path"), "/assets/app.css");
	assert.equal(field(ok, "status"), "200");
	assert.equal(field(ok, "client"), "203.0.113.9");
	assert.equal(field(ok, "user_agent"), "Mozilla/5.0 (X11; Linux x86_64)");
	const missing = only(
		'203.0.113.9 - - [21/Nov/2026:10:15:42 +0000] "GET /wp-login.php HTTP/1.1" 404 153 "-" "curl/8.5.0"',
	);
	assert.equal(missing.level, "warn");
	assert.equal(field(missing, "referrer"), undefined);
	const bad = only(
		'203.0.113.9 - ada [21/Nov/2026:10:15:42 +0000] "POST /api/orders HTTP/1.1" 502 157 "-" "-"',
	);
	assert.equal(bad.level, "error");
	assert.equal(field(bad, "user"), "ada");
});

test("nginx error lines carry their level in brackets", () => {
	const entry = only(
		`${T} 2026/11/21 10:15:42 [error] 29#29: *7 connect() failed (111: Connection refused) while connecting to upstream`,
	);
	assert.equal(entry.level, "error");
	assert.equal(
		entry.message,
		"*7 connect() failed (111: Connection refused) while connecting to upstream",
	);
	assert.equal(field(entry, "pid"), "29");
	assert.equal(entry.appTimestamp, "2026/11/21 10:15:42");
});

test("other request lines", () => {
	assert.equal(detectTextLevel("npm warn deprecated"), "warn");
	assert.equal(only(" GET /dashboard 200 in 52ms").level, "info");
	assert.equal(only("GET /api/users 500 12.412 ms - 42").level, "error");
	assert.equal(
		only(
			'INFO:     10.0.0.5:51234 - "GET /items HTTP/1.1" 500 Internal Server Error',
		).level,
		"error",
	);
});

test("Postgres: levels, and statement details stay with their error", () => {
	const entries = parseLogText(
		stamped([
			"2026-11-21 10:15:42.101 UTC [1] LOG:  database system is ready to accept connections",
			'2026-11-21 10:15:42.118 UTC [77] ERROR:  relation "orders" does not exist at character 15',
			"2026-11-21 10:15:42.118 UTC [77] STATEMENT:  select * from orders",
			"\t\twhere id = 1",
			"2026-11-21 10:15:42.300 UTC [77] FATAL:  terminating connection due to administrator command",
			"2026-11-21 10:15:42.400 UTC [1] WARNING:  could not open statistics file",
		]),
	);
	assert.deepEqual(
		entries.map((entry) => entry.level),
		["info", "error", "error", "warn"],
	);
	assert.equal(
		entries[0]?.message,
		"database system is ready to accept connections",
	);
	assert.equal(field(entries[0] as LogEntry, "pid"), "1");
	assert.deepEqual(entries[1]?.attached, [
		"2026-11-21 10:15:42.118 UTC [77] STATEMENT:  select * from orders",
		"\t\twhere id = 1",
	]);
});

test("a program's own zoned timestamp is used when the runtime gave none", () => {
	const entry = only(
		"2026-11-21 10:15:42.101 UTC [1] LOG:  checkpoint starting: time",
	);
	assert.equal(entry.timestamp?.toISOString(), "2026-11-21T10:15:42.101Z");
	assert.equal(entry.message, "checkpoint starting: time");
	assert.equal(entry.appTimestamp, "2026-11-21 10:15:42.101 UTC");
	const local = only("2026-11-21 10:15:42,101 - worker - ERROR - job failed");
	assert.equal(local.timestamp, null);
	assert.equal(local.level, "error");
	// No time of our own and none that can be placed: the printed one stays.
	assert.equal(local.message, "2026-11-21 10:15:42,101 job failed");
	assert.equal(local.logger, "worker");
	assert.equal(local.appTimestamp, null);
	const gunicorn = only(
		"[2026-11-21 10:15:42 +0000] [7] [INFO] Starting gunicorn 23.0.0",
	);
	assert.equal(gunicorn.timestamp?.toISOString(), "2026-11-21T10:15:42.000Z");
	assert.equal(gunicorn.level, "info");
	assert.equal(gunicorn.message, "Starting gunicorn 23.0.0");
	assert.equal(field(gunicorn, "pid"), "7");
});

test("Redis marks", () => {
	const lines = [
		["1:M 21 Nov 2026 10:15:42.101 * Ready to accept connections tcp", "info"],
		[
			"1:M 21 Nov 2026 10:15:42.101 # WARNING Memory overcommit must be enabled!",
			"warn",
		],
		["1:C 21 Nov 2026 10:15:42.101 - Accepted 10.0.1.4:51022", "debug"],
		["1:M 21 Nov 2026 10:15:42.101 . 0 clients connected", "debug"],
	] as const;
	for (const [line, level] of lines) assert.equal(only(line).level, level);
});

test("common text prefixes", () => {
	const cases: [string, string | null][] = [
		["ERROR: failed to solve: process did not complete", "error"],
		["[warn] config file is world-readable", "warn"],
		["<info> starting worker", "info"],
		[
			"E1121 10:15:42.123456       1 reflector.go:138] Failed to watch",
			"error",
		],
		["W1121 10:15:42.123456       1 warnings.go:70] deprecated", "warn"],
		["I1121 10:15:42.123456       1 server.go:1] Started", "info"],
		["WARN[0001] no config file found      path=/etc/app.yml", "warn"],
		["INFO[0000] API listen on /var/run/docker.sock", "info"],
		["ERRO[0004] error waiting for container", "error"],
		[
			"2026-11-21 10:15:42.123 ERROR 1 --- [main] o.s.b.SpringApplication : Application run failed",
			"error",
		],
		[
			"10:15:42.123 [main] DEBUG com.zaxxer.hikari.HikariConfig - maximumPoolSize",
			"debug",
		],
		["2026-11-21 10:15:42.123 | WARNING  | app.jobs:run:41 - retrying", "warn"],
		[
			"[Nest] 1  - 11/21/2026, 10:15:42 AM     LOG [NestFactory] Starting Nest application...",
			"info",
		],
		["npm ERR! code ELIFECYCLE", "error"],
		["npm warn deprecated inflight@1.0.6", "warn"],
		["error Command failed with exit code 1.", "error"],
		["src/app.ts(14,3): error TS2304: Cannot find name 'foo'.", "error"],
		["main.c:3:5: warning: unused variable 'x' [-Wunused-variable]", "warn"],
		["error[E0308]: mismatched types", "error"],
		["TypeError: Cannot read properties of undefined (reading 'id')", "error"],
		["thread 'main' panicked at src/main.rs:4:5:", "error"],
		["❌ Docker build failed", "error"],
		["Failed to create panara-cloud-network ❌", "error"],
		[" > 12 | RUN npm run build", "error"],
		["✅ Docker build completed.", null],
		["Trace: checkpoint reached", "trace"],
		["DEBUG1:  autovacuum: processing database", "debug"],
		["server listening on :3000", null],
		["Processing 12 errors from the last run", null],
		["GET /ERROR/report 200", "info"],
		["Fetching https://example.test/error-pages.tar", null],
	];
	for (const [line, level] of cases) {
		assert.equal(only(line).level, level, line);
	}
});

test("stderr is only a hint: it needs a word that suggests a failure", () => {
	assert.equal(parseLine("connection refused by peer").level, null);
	assert.equal(
		parseLine("connection refused by peer", { stream: "stderr" }).level,
		"error",
	);
	assert.equal(
		parseLine("listening on :8080", { stream: "stderr" }).level,
		null,
	);
	assert.equal(
		parseLine("INFO retry failed", { stream: "stderr" }).level,
		"info",
	);
});

test("Python traceback: one entry named after the exception", () => {
	const entries = parseLogText(
		stamped([
			"INFO:app:handling request",
			"Traceback (most recent call last):",
			'  File "/app/main.py", line 12, in handler',
			"    result = compute(x)",
			'  File "/app/main.py", line 5, in compute',
			"    return 1 / x",
			"ZeroDivisionError: division by zero",
			"INFO:app:next request",
		]),
	);
	assert.equal(entries.length, 3);
	const trace = entries[1] as LogEntry;
	assert.equal(trace.level, "error");
	assert.equal(trace.message, "ZeroDivisionError: division by zero");
	assert.equal(trace.raw, "Traceback (most recent call last):");
	assert.equal(trace.attached.length, 5);
	assert.equal(entries[2]?.message, "next request");
	assert.equal(entries[2]?.logger, "app");
});

test("Python traceback under the error that reports it, with a chained cause", () => {
	const entries = parseLogText(
		[
			"ERROR:app:Unhandled exception in worker",
			"Traceback (most recent call last):",
			'  File "/app/db.py", line 8, in connect',
			"    raise ConnectionError('refused')",
			"ConnectionError: refused",
			"",
			"During handling of the above exception, another exception occurred:",
			"",
			"Traceback (most recent call last):",
			'  File "/app/worker.py", line 30, in run',
			"    connect()",
			"RuntimeError: worker could not start",
			"INFO:app:restarting",
		].join("\n"),
	);
	assert.equal(entries.length, 2);
	assert.equal(entries[0]?.message, "Unhandled exception in worker");
	assert.equal(entries[0]?.attached.length, 9);
	assert.equal(
		entries[0]?.attached.at(-1),
		"RuntimeError: worker could not start",
	);
});

test("Java stack trace: exception line, frames and causes attach to the error", () => {
	const entries = parseLogText(
		[
			"2026-11-21 10:15:42.123 ERROR 1 --- [nio-8080-exec-1] o.a.c.c.C.[dispatcherServlet] : Servlet.service() threw exception",
			"java.lang.IllegalStateException: Cannot process order 4412",
			"\tat com.example.shop.OrderService.process(OrderService.java:42)",
			"\tat com.example.shop.OrderController.create(OrderController.java:18)",
			"Caused by: java.sql.SQLTransientConnectionException: HikariPool-1 - Connection is not available",
			"\tat com.zaxxer.hikari.pool.HikariPool.createTimeoutException(HikariPool.java:696)",
			"\t... 12 more",
			"2026-11-21 10:15:43.001  INFO 1 --- [main] c.e.shop.Application : Started",
		].join("\n"),
	);
	assert.equal(entries.length, 2);
	assert.equal(entries[0]?.level, "error");
	assert.equal(entries[0]?.attached.length, 6);
	assert.equal(entries[1]?.level, "info");
});

test("an uncaught Java exception starts its own error entry", () => {
	const entries = parseLogText(
		[
			"Starting worker",
			'Exception in thread "main" java.lang.RuntimeException: boom',
			"\tat com.example.Main.main(Main.java:5)",
		].join("\n"),
	);
	assert.equal(entries.length, 2);
	assert.equal(entries[1]?.level, "error");
	assert.equal(entries[1]?.attached.length, 1);
});

test("JavaScript stack frames attach, and mark an unlabelled line as an error", () => {
	const entries = parseLogText(
		[
			"Unhandled rejection in job 44",
			"    at getUser (/app/src/users.js:14:22)",
			"    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
			"ready",
		].join("\n"),
	);
	assert.equal(entries.length, 2);
	assert.equal(entries[0]?.level, "error");
	assert.equal(entries[0]?.attached.length, 2);
});

test("Go panic: the goroutine dump stays with the panic", () => {
	const entries = parseLogText(
		[
			"2026/11/21 10:15:42 http: listening on :8080",
			"panic: runtime error: index out of range [5] with length 3",
			"",
			"goroutine 1 [running]:",
			"main.process(...)",
			"\t/app/main.go:42",
			"main.main()",
			"\t/app/main.go:17 +0x1d",
			"exit status 2",
			"2026/11/21 10:15:44 http: listening on :8080",
		].join("\n"),
	);
	assert.equal(entries.length, 3);
	assert.equal(entries[1]?.level, "error");
	assert.equal(
		entries[1]?.message,
		"panic: runtime error: index out of range [5] with length 3",
	);
	assert.equal(entries[1]?.attached.length, 6);
});

test("indented lines join a logger's record but not plain printed output", () => {
	const record = parseLogText(
		["WARN  config has unknown keys:", "  - cache.ttl", "  - cache.size"].join(
			"\n",
		),
	);
	assert.equal(record.length, 1);
	assert.equal(record[0]?.attached.length, 2);
	const banner = parseLogText(
		[
			"> web@1.0.0 start",
			"   ▲ Next.js 16.0.1",
			"   - Local:        http://localhost:3000",
			" ✓ Ready in 412ms",
		].join("\n"),
	);
	assert.equal(banner.length, 4);
	assert.equal(banner[1]?.message, "   ▲ Next.js 16.0.1");
	const sealed = parseLogText(["ERROR boom", "", "  unrelated"].join("\n"));
	assert.equal(sealed.length, 2);
});

test("step markers are sections; a tailed file's header is not a row", () => {
	const entries = parseLogText(
		[
			"==> /var/log/gitlab/gitaly/current <==",
			'{"level":"info","msg":"started"}',
			"",
			"==> /var/log/gitlab/nginx/error.log <==",
			"2026/11/21 10:15:42 [warn] 12#0: conflicting server name",
			"── Build ──",
			"## Cloning repository",
			"=====EXTRA LOGS=====",
		].join("\n"),
	);
	assert.deepEqual(
		entries.map((entry) => [entry.kind, entry.message, entry.source]),
		[
			["entry", "started", "/var/log/gitlab/gitaly/current"],
			[
				"entry",
				"2026/11/21 10:15:42 conflicting server name",
				"/var/log/gitlab/nginx/error.log",
			],
			["section", "Build", null],
			["section", "Cloning repository", null],
			["section", "EXTRA LOGS", null],
		],
	);
});

test("a rule with nothing in it is a line like any other", () => {
	const entries = parseLogText("------\n====================\n--- done ---");
	assert.deepEqual(
		entries.map((entry) => [entry.kind, entry.message]),
		[
			["entry", "------"],
			["entry", "===================="],
			["section", "done"],
		],
	);
});

test("a compose or swarm prefix names the source", () => {
	const compose = only("worker-2  | job 81 finished");
	assert.equal(compose.source, "worker-2");
	assert.equal(compose.message, "job 81 finished");
	const swarm = only(
		'api.3.k3x9a7@node-2    | level=error msg="db down" attempt=3',
	);
	assert.equal(swarm.source, "api.3.k3x9a7@node-2");
	assert.equal(swarm.level, "error");
	assert.equal(only("a | b").source, null);
});

test("ANSI colours stay in the message; levels are read underneath them", () => {
	const line = "\x1b[31mERROR\x1b[0m \x1b[2mdb\x1b[0m connection lost";
	const entry = only(`${T} ${line}`);
	assert.equal(entry.level, "error");
	assert.equal(entry.raw, line);
	// The level has its column; the colours of what follows stay.
	assert.equal(entry.message, "\x1b[2mdb\x1b[0m connection lost");
	assert.equal(entry.text, "ERROR db connection lost");
	assert.equal(stripAnsi("\x1b[38;5;208mx\x1b[0m\x1b]8;;http://a\x07y"), "xy");
});

test("plain text passes through untouched", () => {
	const entry = only("Compiled successfully in 4.2s");
	assert.equal(entry.format, "text");
	assert.equal(entry.level, null);
	assert.deepEqual(entry.fields, []);
	assert.deepEqual(entry.attached, []);
});

test("a redrawn line keeps what was printed last", () => {
	assert.equal(
		only("Downloading 10%\rDownloading 80%\rDownloaded\r").message,
		"Downloaded",
	);
});

test("a stream is parsed once, across chunks that cut lines", () => {
	const buffer = new LogBuffer();
	buffer.push(`${T} first li`);
	assert.equal(buffer.entries.length, 0);
	buffer.push(`ne\n${T} {"level":"warn","ms`);
	assert.equal(buffer.entries.length, 1);
	const first = buffer.entries[0];
	buffer.push('g":"slow query"}\n');
	assert.equal(buffer.entries.length, 2);
	assert.equal(buffer.entries[0], first);
	assert.equal(buffer.entries[1]?.message, "slow query");
	assert.equal(buffer.entries[1]?.level, "warn");
	buffer.push("tail without newline");
	buffer.end();
	assert.equal(buffer.entries.length, 3);
	assert.deepEqual(
		buffer.entries.map((entry) => entry.id),
		[1, 2, 3],
	);
});

test("the buffer keeps the newest entries", () => {
	const buffer = new LogBuffer({ maxEntries: 100 });
	for (let i = 0; i < 25; i++) {
		buffer.push(
			Array.from({ length: 10 }, (_, j) => `line ${i * 10 + j}`).join("\n") +
				"\n",
		);
	}
	assert.ok(buffer.entries.length <= 110);
	assert.equal(buffer.entries.at(-1)?.message, "line 249");
	assert.equal(buffer.entries.at(-1)?.id, 250);
	buffer.clear();
	buffer.push("again\n");
	assert.equal(buffer.entries[0]?.id, 251);
});

test("growing text is only parsed past what was read", () => {
	const buffer = new LogBuffer();
	buffer.setText("step one\nERROR bro");
	assert.deepEqual(
		buffer.entries.map((entry) => entry.message),
		["step one", "bro"],
	);
	const first = buffer.entries[0];
	buffer.setText("step one\nERROR broke\n    at build (/app/x.js:1:1)\nstep t");
	assert.equal(buffer.entries[0], first);
	assert.deepEqual(
		buffer.entries.map((entry) => [entry.message, entry.attached.length]),
		[
			["step one", 0],
			["broke", 1],
			["step t", 0],
		],
	);
	buffer.setText(
		"step one\nERROR broke\n    at build (/app/x.js:1:1)\nstep two\n",
	);
	assert.deepEqual(
		buffer.entries.map((entry) => entry.message),
		["step one", "broke", "step two"],
	);
	assert.deepEqual(
		buffer.entries.map((entry) => entry.id),
		[1, 2, 3],
	);
	buffer.setText("another log\n");
	assert.deepEqual(
		buffer.entries.map((entry) => entry.message),
		["another log"],
	);
});

test("an unfinished frame does not stay attached once the line completes", () => {
	const buffer = new LogBuffer();
	buffer.setText("ERROR boom\n    at ");
	assert.equal(buffer.entries[0]?.attached.length, 1);
	buffer.setText("ERROR boom\n    at run (/app/a.js:1:1)\nok\n");
	assert.deepEqual(buffer.entries[0]?.attached, ["    at run (/app/a.js:1:1)"]);
	assert.equal(buffer.entries.length, 2);
});

test("line-per-entry parsing attaches nothing", () => {
	const entries = parseLogLines("ERROR boom\n    at run (/app/a.js:1:1)\n\nok");
	assert.equal(entries.length, 3);
	assert.equal(entries[1]?.message, "    at run (/app/a.js:1:1)");
});

test("filters: levels, and text across the message and what is attached", () => {
	const entries = parseLogText(
		[
			"## Build",
			"ERROR payment failed",
			"    at charge (/app/pay.js:9:1)",
			"WARN slow query",
			"INFO started",
			"DEBUG cache miss",
			"TRACE enter fn",
			"plain line",
		].join("\n"),
	);
	const levels = (list: string[]) =>
		filterEntries(entries, { levels: new Set(list) as never }).map(
			(entry) => entry.message,
		);
	assert.deepEqual(levels(["error"]), ["payment failed"]);
	assert.deepEqual(levels(["error", "warn"]), ["payment failed", "slow query"]);
	assert.deepEqual(levels(["debug"]), ["cache miss", "enter fn"]);
	assert.deepEqual(levels(["other"]), ["plain line"]);
	assert.equal(filterEntries(entries, {}).length, entries.length);
	assert.deepEqual(
		filterEntries(entries, { search: "PAY.JS" }).map((entry) => entry.message),
		["payment failed"],
	);
	assert.deepEqual(
		filterEntries(entries, { search: "a.b(" }).map((entry) => entry.message),
		[],
	);
	assert.equal(levelBucket(null), "other");
});

test("copy and download text: as printed, colours removed", () => {
	const entry = only(
		`${T} \x1b[31mERROR\x1b[0m boom\n${T}     at run (/app/a.js:1:1)`,
	);
	assert.equal(entryText(entry), `${T} ERROR boom\n    at run (/app/a.js:1:1)`);
	assert.equal(
		entryText(entry, { timestamps: false }),
		"ERROR boom\n    at run (/app/a.js:1:1)",
	);
});

// Copied from a Caddy container: zap's console output, tabs between the
// columns and a colour on the level.
const CADDY_FIELDS =
	'{"request": {"remote_ip": "127.0.0.1", "remote_port": "46578", "client_ip": "127.0.0.1", "proto": "HTTP/1.1", "method": "GET", "host": "127.0.0.1:3000", "uri": "/", "headers": {"Accept": ["*/*"], "User-Agent": ["curl/8.23.0"]}}, "bytes_read": 0, "user_id": "", "duration": 0.000619441, "size": 6337, "status": 200, "resp_headers": {"X-Xss-Protection": ["1; mode=block"], "X-Content-Type-Options": ["nosniff"], "Vary": ["Accept-Encoding"], "Etag": ["\\"dmwpq4drr0g0-4w1\\""], "Content-Type": ["text/html; charset=utf-8"], "X-Frame-Options": ["DENY"], "Last-Modified": ["Mon, 16 Nov 2026 14:42:09 GMT"], "Accept-Ranges": ["bytes"], "Content-Length": ["6337"], "Server": ["Caddy"]}}';
const CADDY = `2026/11/22 03:56:54.582\t\x1b[34mINFO\x1b[0m\thttp.log.access.log0\thandled request\t${CADDY_FIELDS}`;

test("Caddy: the row is the message, not the timestamp and level again", () => {
	const entry = only(`2026-11-22T03:56:54.583104211Z ${CADDY}`);
	assert.equal(entry.timestamp?.toISOString(), "2026-11-22T03:56:54.583Z");
	assert.equal(entry.level, "info");
	assert.equal(entry.message, "handled request");
	assert.equal(entry.logger, "http.log.access.log0");
	assert.equal(entry.appTimestamp, "2026/11/22 03:56:54.582");
	assert.equal(entry.format, "mixed");
	assert.equal(entry.raw, CADDY);
	assert.equal(field(entry, "request.method"), "GET");
	assert.equal(field(entry, "resp_headers.Server"), '["Caddy"]');
	assert.deepEqual(
		rowFields(entry, 6).map(({ key, value }) => `${key}=${value}`),
		["method=GET", "uri=/", "status=200", "duration=619 µs"],
	);
	// The value as logged is what the detail shows.
	assert.equal(field(entry, "duration"), "0.000619441");
	// Printed in the container's own zone, a millisecond before ours.
	assert.equal(differingAppTimestamp(entry), null);
	assert.equal(
		entryText(entry),
		`2026-11-22T03:56:54.583104211Z ${stripAnsi(CADDY)}`,
	);
});

test("Caddy: a failed request raises the level its logger gave", () => {
	const entry = only(
		`2026/11/22 03:56:54.582\tINFO\thttp.log.access.log0\thandled request\t{"request": {"method": "GET", "uri": "/api"}, "status": 502}`,
	);
	assert.equal(entry.level, "error");
	assert.equal(entry.message, "2026/11/22 03:56:54.582 handled request");
});

test("zap console output with a caller column", () => {
	const entry = only(
		`${T} 2026-11-21T10:15:42.120Z\tWARN\tcontroller\tserver/handler.go:88\tretrying\t{"attempt": 3}`,
	);
	assert.equal(entry.level, "warn");
	assert.equal(entry.logger, "controller");
	assert.equal(entry.message, "retrying");
	assert.equal(field(entry, "caller"), "server/handler.go:88");
	assert.equal(field(entry, "attempt"), "3");
});

test("the program's timestamp shows in the detail only when it says another time", () => {
	const late = only(`2026-11-22T03:57:10.000Z ${CADDY}`);
	assert.equal(differingAppTimestamp(late), "2026/11/22 03:56:54.582");
	const zoned = only(`${T} 2026-11-21 15:45:42.120 +05:30 INFO ready`);
	assert.equal(zoned.message, "ready");
	assert.equal(differingAppTimestamp(zoned), null);
	const behind = only(`${T} 2026-11-21T10:15:12Z INFO ready`);
	assert.equal(differingAppTimestamp(behind), "2026-11-21T10:15:12Z");
	assert.equal(differingAppTimestamp(only(`${T} plain`)), null);
});

test("a row never repeats the timestamp and level it has columns for", () => {
	const cases: [string, string, string | null, string | null][] = [
		[
			"[2026-11-22 03:56:24] INFO: server started",
			"server started",
			"info",
			null,
		],
		[
			"2026-11-22T03:56:24.522Z info cache warmed",
			"cache warmed",
			"info",
			null,
		],
		["INFO 2026-11-22 03:56:24 cache warmed", "cache warmed", "info", null],
		[
			"2026-11-22 03:56:24,522 - app.worker - INFO - job 12 done",
			"job 12 done",
			"info",
			"app.worker",
		],
		[
			"2026-11-22 03:56:24.522 UTC [71] LOG:  checkpoint complete",
			"checkpoint complete",
			"info",
			null,
		],
		[
			"2026/11/22 03:56:24 [error] 31#31: *4 upstream timed out",
			"*4 upstream timed out",
			"error",
			null,
		],
		[
			"1:M 22 Nov 2026 03:56:24.522 * Ready to accept connections tcp",
			"Ready to accept connections tcp",
			"info",
			null,
		],
		[
			"1:M 22 Nov 2026 03:56:24.522 # WARNING Memory overcommit must be enabled!",
			"WARNING Memory overcommit must be enabled!",
			"warn",
			null,
		],
		[
			"E1122 03:56:24.522134       1 reflector.go:138] Failed to watch *v1.Pod",
			"Failed to watch *v1.Pod",
			"error",
			"reflector.go:138",
		],
		[
			"2026/11/22 03:56:24 http: TLS handshake error",
			"http: TLS handshake error",
			null,
			null,
		],
		[
			"2026/11/22 03:56:24.522134 listening on :8080",
			"listening on :8080",
			null,
			null,
		],
		[
			"2026-11-22 03:56:24.522 ERROR 1 --- [main] o.s.b.SpringApplication : Application run failed",
			"Application run failed",
			"error",
			"o.s.b.SpringApplication",
		],
		[
			"03:56:24.522 [main] DEBUG com.zaxxer.hikari.HikariConfig - maximumPoolSize",
			"maximumPoolSize",
			"debug",
			"com.zaxxer.hikari.HikariConfig",
		],
		[
			"2026-11-22 03:56:24.522 | WARNING  | app.jobs:run:41 - retrying",
			"retrying",
			"warn",
			"app.jobs:run:41",
		],
		[
			"[2026-11-22 03:56:24 +0000] [7] [INFO] Booting worker with pid: 7",
			"Booting worker with pid: 7",
			"info",
			null,
		],
		[
			"[2026-11-22 03:56:24] production.ERROR: Connection refused",
			"Connection refused",
			"error",
			"production",
		],
		[
			"[Nest] 1  - 11/22/2026, 3:56:24 AM     LOG [NestFactory] Starting Nest application...",
			"Starting Nest application...",
			"info",
			"NestFactory",
		],
		[
			"Nov 22 03:56:24 host sshd[812]: Accepted publickey",
			"host sshd[812]: Accepted publickey",
			null,
			null,
		],
		["WARN[0001] no config file found", "no config file found", "warn", null],
		[
			"[warn] config file is world-readable",
			"config file is world-readable",
			"warn",
			null,
		],
		["<info> starting worker", "starting worker", "info", null],
		[
			"ERROR: failed to solve: exit code 1",
			"failed to solve: exit code 1",
			"error",
			null,
		],
		[
			"WARNING:urllib3.connectionpool:Retrying",
			"Retrying",
			"warn",
			"urllib3.connectionpool",
		],
		["INFO  starting up", "starting up", "info", null],
		[
			"2026-11-22 03:56:24 [INFO] [worker] job done",
			"job done",
			"info",
			"worker",
		],
	];
	for (const [line, message, level, logger] of cases) {
		const entry = only(`${T} ${line}`);
		assert.equal(entry.message, message, line);
		assert.equal(entry.level, level, line);
		assert.equal(entry.logger, logger, line);
		assert.equal(entry.raw, line, line);
	}
});

test("a level word that is the sentence stays in the message", () => {
	const cases: [string, string | null][] = [
		["Error: Cannot find module 'x'", "error"],
		["error Command failed with exit code 1.", "error"],
		["Error loading the configuration", "error"],
		["panic: runtime error: index out of range", "error"],
		["npm ERR! code ELIFECYCLE", "error"],
		["TypeError: x is not a function", "error"],
		["src/app.ts(14,3): error TS2304: Cannot find name 'foo'.", "error"],
		["Processing 12 errors from the last run", null],
		["INFO", "info"],
	];
	for (const [line, level] of cases) {
		const entry = only(`${T} ${line}`);
		assert.equal(entry.message, line, line);
		assert.equal(entry.level, level, line);
	}
});

test("build output: errors and warnings stand out under BuildKit's step numbers", () => {
	const cases: [string, string | null][] = [
		[
			"#7 4.812 npm warn deprecated inflight@1.0.6: This module is not supported",
			"warn",
		],
		["#8 6.120 Failed to compile.", "error"],
		["#8 6.121 Type error: Cannot find name 'foo'.", "error"],
		[
			'#8 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1',
			"error",
		],
		["#7 9.341 added 512 packages in 9s", null],
		["#1 [internal] load build definition from Dockerfile", null],
		["#7 DONE 9.6s", null],
		["Failed to compile.", "error"],
	];
	for (const [line, level] of cases) {
		const entry = only(line);
		assert.equal(entry.level, level, line);
		assert.equal(entry.message, line, line);
	}
});

test("a JSON record of an exception reads as its message", () => {
	const entry = only(
		'{"severity":"ERROR","time":"2026-11-22T06:39:13.159Z","exception.class":"Gitlab::Git::CommandError","exception.message":"13:reading repository: exit status 128"}',
	);
	assert.equal(entry.message, "13:reading repository: exit status 128");
	assert.equal(
		only('{"time":"2026-11-22T06:39:13.159Z","pid":612,"workers":4}').message,
		"pid=612 workers=4",
	);
});

test("a received time stands in for the runtime's", () => {
	const buffer = new LogBuffer();
	const text =
		"Cloning repository\n2026-11-22 03:56:24 [INFO] built\n pulling layer\n";
	buffer.setText(text, [
		{ offset: 0, at: Date.UTC(2026, 10, 22, 4, 0, 0) },
		{ offset: 19, at: Date.UTC(2026, 10, 22, 4, 0, 5) },
	]);
	assert.deepEqual(
		buffer.entries.map((entry) => [
			entry.message,
			entry.timestamp?.toISOString(),
			entry.rawTimestamp,
		]),
		[
			["Cloning repository", "2026-11-22T04:00:00.000Z", null],
			["built", "2026-11-22T04:00:05.000Z", null],
			["pulling layer", "2026-11-22T04:00:05.000Z", null],
		],
	);
	assert.equal(buffer.entries[1]?.appTimestamp, "2026-11-22 03:56:24");
	const partial = new LogBuffer();
	partial.setText("one\ntw", [{ offset: 0, at: 1000 }]);
	partial.setText("one\ntwo\n", [
		{ offset: 0, at: 1000 },
		{ offset: 6, at: 9000 },
	]);
	assert.deepEqual(
		partial.entries.map((entry) => entry.timestamp?.getTime()),
		[1000, 1000],
	);
});

test("Docker's one-space indent is dropped; real indentation stays", () => {
	const entries = parseLogText(
		[
			" gitlab Pulling",
			" dbb4936169dd Pulling fs layer",
			"   ▲ Next.js 16.0.1",
			"Command: docker compose up -d",
		].join("\n"),
	);
	assert.deepEqual(
		entries.map((entry) => entry.message),
		[
			"gitlab Pulling",
			"dbb4936169dd Pulling fs layer",
			"   ▲ Next.js 16.0.1",
			"Command: docker compose up -d",
		],
	);
	assert.equal(entries[0]?.raw, " gitlab Pulling");
});

test("a combined access line reads as its request", () => {
	const entry = only(
		`${T} 172.19.0.6 - gitlab-ci-token [22/Nov/2026:06:39:11 +0000] "POST /acme/storefront.git/git-upload-pack HTTP/1.1" 200 580 "" "gitlab-runner 19.6.0 linux/amd64" -`,
	);
	assert.equal(entry.format, "access");
	assert.equal(entry.message, "POST /acme/storefront.git/git-upload-pack 200");
	assert.equal(entry.appTimestamp, "22/Nov/2026:06:39:11 +0000");
	assert.deepEqual(
		rowFields(entry, 6).map(({ key, value }) => `${key}=${value}`),
		[],
	);
	assert.equal(field(entry, "user"), "gitlab-ci-token");
	const alone = only(
		'203.0.113.9 - - [21/Nov/2026:10:15:42 +0000] "GET / HTTP/1.1" 200 12',
	);
	assert.equal(alone.timestamp?.toISOString(), "2026-11-21T10:15:42.000Z");
});

// What `tail -f` over GitLab's log directory prints: a header whenever the
// next line comes from another file.
const GITLAB_TAIL = [
	"==> /var/log/gitlab/gitlab-workhorse/current <==",
	'{"correlation_id":"01M80ZNS75GVCC2SJEH3BXJ2W0","level":"info","msg":"git_traffic","project_id":14,"service":"git-upload-pack","written_bytes":568}',
	"",
	"==> /var/log/gitlab/nginx/gitlab_access.log <==",
	'172.19.0.6 - gitlab-ci-token [22/Nov/2026:06:39:11 +0000] "POST /acme/storefront.git/git-upload-pack HTTP/1.1" 200 580 "" "gitlab-runner 19.6.0 linux/amd64" -',
	"",
	"==> /var/log/gitlab/gitlab-rails/application_json.log <==",
	'{"severity":"INFO","time":"2026-11-22T06:39:11.429Z","correlation_id":"01M80ZNV1EQVJEJCTZYQSFE411","meta.client_type":"system","class":"Ci::AuthJobFinder","job_id":8619,"message":"successful job token auth"}',
	"",
	"==> /var/log/gitlab/gitlab-rails/sidekiq_client.log <==",
	'{"severity":"INFO","time":"2026-11-22T06:39:11.464Z","retry":3,"queue":"default","class":"FlushCounterIncrementsWorker","message":"FlushCounterIncrementsWorker JID-67a6ee143c0e5fb5b90b7452: deduplicated: until executed"}',
	"",
	"==> /var/log/gitlab/gitlab-rails/application_json.log <==",
	'{"severity":"INFO","time":"2026-11-22T06:39:11.464Z","message":"Increment counter attribute"}',
	"",
	"==> /var/log/gitlab/gitlab-rails/application_json.log <==",
	'{"severity":"INFO","time":"2026-11-22T06:39:11.465Z","message":"Increment counter attribute again"}',
	"",
	"==> /var/log/gitlab/gitlab-rails/production_json.log <==",
	'{"method":"POST","path":"/acme/storefront.git/git-upload-pack","format":null,"controller":"Repositories::GitHttpController","status":200,"time":"2026-11-22T06:39:11.468Z","duration_s":0.03,"correlation_id":"01M80ZNV1EQVJEJCTZYQSFE411"}',
	"",
	"==> /var/log/gitlab/gitaly/current <==",
	'{"command.count":1,"component":"gitaly.UnaryServerInterceptor","correlation_id":"01M80ZNS75GVCC2SJEH3BXJ2W0","level":"error","msg":"finished unary call with code Internal"}',
	"    at gitaly/internal/service.go:41",
	"",
	"==> /var/log/gitlab/gitlab-workhorse/current <==",
	"  an indented line of another file",
].join("\n");

test("a tail of several files is one list: the file is each line's source", () => {
	const buffer = new LogBuffer();
	buffer.push(`${GITLAB_TAIL}\n`);
	const { entries } = buffer;
	assert.ok(entries.every((entry) => entry.kind === "entry"));
	assert.deepEqual(
		entries.map((entry) => entry.source),
		[
			"/var/log/gitlab/gitlab-workhorse/current",
			"/var/log/gitlab/nginx/gitlab_access.log",
			"/var/log/gitlab/gitlab-rails/application_json.log",
			"/var/log/gitlab/gitlab-rails/sidekiq_client.log",
			"/var/log/gitlab/gitlab-rails/application_json.log",
			"/var/log/gitlab/gitlab-rails/application_json.log",
			"/var/log/gitlab/gitlab-rails/production_json.log",
			"/var/log/gitlab/gitaly/current",
			"/var/log/gitlab/gitlab-workhorse/current",
		],
	);
	assert.equal(buffer.sources.length, 6);
	// A stack frame stays with its error; a line of the next file does not.
	assert.equal(entries[7]?.attached.length, 1);
	assert.equal(entries[8]?.message, "  an indented line of another file");
	const labels = sourceLabels(buffer.sources);
	assert.deepEqual(
		[...labels.values()],
		[
			"gitlab-workhorse",
			"nginx/gitlab_access",
			"gitlab-rails/application_json",
			"gitlab-rails/sidekiq_client",
			"gitlab-rails/production_json",
			"gitaly",
		],
	);
	assert.deepEqual(
		filterEntries(entries, {
			sources: new Set(["/var/log/gitlab/gitaly/current"]),
		}).map((entry) => entry.message),
		["finished unary call with code Internal"],
	);
	// Copying gives the headers back, once per run of lines.
	const copied = entriesText(entries);
	assert.equal(copied.match(/^==> /gm)?.length, 8);
	assert.ok(
		copied.startsWith("==> /var/log/gitlab/gitlab-workhorse/current <==\n{"),
	);
	assert.deepEqual(
		parseLogText(copied).map((entry) => entry.source),
		entries.map((entry) => entry.source),
	);
});

test("each compose container keeps the file it is tailing", () => {
	const entries = parseLogText(
		[
			"web-1  | ==> /var/log/app/access.log <==",
			"db-1   | ==> /var/log/postgresql/current <==",
			"web-1  | GET / 200",
			"db-1   | LOG:  ready",
			"cache-1  | started",
		].join("\n"),
	);
	assert.deepEqual(
		entries.map((entry) => [entry.source, entry.file]),
		[
			["web-1:/var/log/app/access.log", "/var/log/app/access.log"],
			["db-1:/var/log/postgresql/current", "/var/log/postgresql/current"],
			["cache-1", null],
		],
	);
	assert.deepEqual(
		[...sourceLabels(entries.map((entry) => entry.source ?? "")).values()],
		["web-1 app/access", "db-1 postgresql", "cache-1"],
	);
});

test("source names: short, and told apart when two files share one", () => {
	assert.deepEqual(
		[
			...sourceLabels([
				"/var/log/syslog",
				"/srv/a/logs/error.log",
				"/srv/b/logs/error.log",
				"/var/log/gitlab/puma/puma_stdout.log",
			]).values(),
		],
		["syslog", "a/error", "b/error", "puma/puma_stdout"],
	);
});

test("row fields: a few, none the message already says, no blobs or long ids", () => {
	const request = only(
		'{"method":"POST","path":"/api/orders","status":201,"duration_ms":74,"correlation_id":"01M80ZNV1EQVJEJCTZYQSFE411","time":"2026-11-22T06:39:11.468Z"}',
	);
	assert.equal(request.message, "POST /api/orders 201");
	assert.deepEqual(rowFields(request, 4), [
		{ key: "duration", value: "74 ms" },
	]);
	const record = only(
		'{"msg":"job done","correlation_id":"01M80Z","args":["a","b"],"queue":"default","retry":3,"a":1,"b":2,"c":3,"pid":4}',
	);
	assert.deepEqual(
		rowFields(record, 4).map((item) => item.key),
		["queue", "retry", "a", "b"],
	);
	assert.deepEqual(rowFields(only("plain text line"), 4), []);
});

test("a duration in a row reads in a unit; only when the field says its unit", () => {
	assert.equal(formatSeconds(0.000659103), "659 µs");
	assert.equal(formatSeconds(0.0000042), "4.2 µs");
	assert.equal(formatSeconds(0.012), "12 ms");
	assert.equal(formatSeconds(0.0012), "1.2 ms");
	assert.equal(formatSeconds(1.234), "1.2 s");
	assert.equal(formatSeconds(30), "30 s");
	assert.equal(formatSeconds(150), "2.5 min");
	const chips = (line: string) =>
		rowFields(only(line), 4).map(({ key, value }) => `${key}=${value}`);
	assert.deepEqual(
		chips('{"msg":"done","method":"GET","uri":"/","duration_s":0.0313}'),
		["method=GET", "uri=/", "duration=31 ms"],
	);
	assert.deepEqual(
		chips('{"msg":"done","method":"GET","url":"/","responseTime":12}'),
		["method=GET", "url=/", "responseTime=12"],
	);
	assert.deepEqual(
		chips(
			'level=info msg="Request Completed" method=GET path=/api status=200 duration=2.1ms',
		),
		["method=GET", "path=/api", "status=200", "duration=2.1ms"],
	);
	assert.deepEqual(
		chips('{"msg":"job","method":"GET","uri":"/","elapsed":1.5}'),
		["method=GET", "uri=/", "elapsed=1.5"],
	);
});

test("JSON is found whole, at the end of a line and inside one", () => {
	assert.deepEqual(findJson('{"a":1}'), {
		before: "",
		after: "",
		value: { a: 1 },
	});
	const caddy = findJson(stripAnsi(CADDY));
	assert.equal(
		caddy?.before,
		"2026/11/22 03:56:54.582\tINFO\thttp.log.access.log0\thandled request",
	);
	assert.equal((caddy?.value as { status: number }).status, 200);
	assert.deepEqual(findJson('got [1, 2, {"a": null}] from peer'), {
		before: "got",
		after: "from peer",
		value: [1, 2, { a: null }],
	});
	assert.deepEqual(findJson('[main] payload {"ok":true} sent'), {
		before: "[main] payload",
		after: "sent",
		value: { ok: true },
	});
	assert.equal(findJson("nothing {here} at all"), null);
	assert.equal(findJson("[main] started"), null);
	assert.equal(findJson(`{"a":"${"x".repeat(70_000)}"}`), null);
});

test("a string that holds JSON is read one level deeper", () => {
	assert.deepEqual(nestedJson('{"a":[1]}'), { a: [1] });
	assert.deepEqual(nestedJson(" [1,2] "), [1, 2]);
	assert.equal(nestedJson("plain"), undefined);
	assert.equal(nestedJson("{broken"), undefined);
	assert.equal(nestedJson("12"), undefined);
});

test("50,000 lines parse quickly", () => {
	const kinds = [
		'{"level":30,"time":1795256142123,"msg":"request completed","req":{"method":"GET","url":"/api/items"},"res":{"statusCode":200},"responseTime":4}',
		'203.0.113.9 - - [21/Nov/2026:10:15:42 +0000] "GET /a HTTP/1.1" 200 512 "-" "curl/8.5.0"',
		'time="2026-11-21T10:15:42Z" level=info msg="Configuration loaded" entryPointName=web',
		"plain text output from the application",
	];
	const text = Array.from(
		{ length: 50_000 },
		(_, i) => `${T} ${kinds[i % kinds.length]}`,
	).join("\n");
	const started = performance.now();
	const buffer = new LogBuffer();
	buffer.push(`${text}\n`);
	const elapsed = performance.now() - started;
	assert.equal(buffer.entries.length, 50_000);
	assert.ok(elapsed < 3000, `parsing took ${Math.round(elapsed)}ms`);
});

const at = (seconds: number, line: string) =>
	`2026-11-22T11:02:${String(seconds).padStart(2, "0")}.350907922Z ${line}`;

test("a traceback goes under an error line only when they were printed together", () => {
	const lines = (gap: number) => [
		at(0, "ERROR worker crashed, restarting loop"),
		at(gap, "Traceback (most recent call last):"),
		at(gap, '  File "/app/main.py", line 12, in <module>'),
		at(gap, "    run()"),
		at(gap, "ValueError: invalid literal for int() with base 10: 'abc'"),
	];
	// logger.exception: the message and its traceback in the same moment.
	const reported = parseLogText(lines(0).join("\n"));
	assert.equal(reported.length, 1);
	assert.equal(reported[0]?.message, "worker crashed, restarting loop");
	assert.equal(reported[0]?.attached.length, 4);
	// Fifteen seconds later it is another failure.
	const later = parseLogText(lines(15).join("\n"));
	assert.equal(later.length, 2);
	assert.equal(later[0]?.attached.length, 0);
	assert.equal(
		later[1]?.message,
		"ValueError: invalid literal for int() with base 10: 'abc'",
	);
	assert.equal(later[1]?.level, "error");
	assert.equal(later[1]?.attached.length, 3);
});

test("an error that carries its own stack does not take the next traceback", () => {
	// What a container printed in the 0.1.5 pass: a JS error, then a Python
	// traceback, back to back and again fifteen seconds apart.
	for (const gap of [0, 15]) {
		const entries = parseLogText(
			[
				at(0, "TypeError: Cannot read properties of undefined (reading 'id')"),
				at(0, "    at getUser (/app/src/users.js:42:17)"),
				at(0, "    at async handler (/app/src/server.js:118:5)"),
				at(gap, "Traceback (most recent call last):"),
				at(gap, '  File "/app/main.py", line 12, in <module>'),
				at(gap, "    run()"),
				at(gap, "ValueError: invalid literal for int() with base 10: 'abc'"),
			].join("\n"),
		);
		assert.equal(entries.length, 2, `gap ${gap}`);
		assert.equal(entries[0]?.attached.length, 2);
		assert.match(entries[1]?.message ?? "", /^ValueError/);
		assert.equal(entries[1]?.attached.length, 3);
	}
});

test("two tracebacks in a row are two entries unless the second is chained", () => {
	const trace = (name: string) => [
		"Traceback (most recent call last):",
		`  File "/app/${name}.py", line 3, in <module>`,
		`${name.toUpperCase()}Error: ${name}`,
	];
	const separate = parseLogText([...trace("a"), ...trace("b")].join("\n"));
	assert.equal(separate.length, 2);
	assert.equal(separate[0]?.message, "AError: a");
	assert.equal(separate[1]?.message, "BError: b");
	const chained = parseLogText(
		[
			...trace("a"),
			"",
			"During handling of the above exception, another exception occurred:",
			"",
			...trace("b"),
		].join("\n"),
	);
	assert.equal(chained.length, 1);
	assert.equal(chained[0]?.attached.length, 6);
});
