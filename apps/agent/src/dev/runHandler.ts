// Runs host-side code against a real server without Convex, for development:
//   tsx src/dev/runHandler.ts <script.ts>
// The script default-exports `(host, log) => Promise<void>`. Target comes from
// DEV_SSH_HOST, DEV_SSH_PORT, DEV_SSH_USER, DEV_SSH_KEY (a key file path) and
// optionally DEV_SSH_HOST_KEY (the expected SHA256 host key fingerprint),
// or the local machine when DEV_SSH_HOST is unset.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { withHost } from "../host";
import type { Host } from "../host/types";
import { LogSink } from "../logSink";

const scriptPath = process.argv[2];
if (!scriptPath) {
	console.error("usage: tsx src/dev/runHandler.ts <script.ts>");
	process.exit(1);
}

const target = process.env.DEV_SSH_HOST
	? {
			type: "ssh" as const,
			serverId: "dev",
			host: process.env.DEV_SSH_HOST,
			port: Number(process.env.DEV_SSH_PORT ?? 22),
			username: process.env.DEV_SSH_USER ?? "root",
			privateKey: readFileSync(process.env.DEV_SSH_KEY ?? "", "utf8"),
			hostKey: process.env.DEV_SSH_HOST_KEY ?? null,
		}
	: { type: "local" as const };

const log = new LogSink(async (chunks) => {
	for (const chunk of chunks) process.stdout.write(chunk.text);
});

const mod = (await import(resolve(scriptPath))) as {
	default: (host: Host, log: LogSink) => Promise<void>;
};
await withHost(target, undefined, (host) => mod.default(host, log));
await log.flush();
