import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOG_FILE } from "./helpers";

const backendDir = path.resolve(
	import.meta.dirname,
	"../../../../packages/backend",
);

// Account emails to @example.test are only logged (LOG_AUTH_LINKS=true), so
// the tests stream the deployment logs to a file and read links from it.
export default async function globalSetup() {
	mkdirSync(path.dirname(LOG_FILE), { recursive: true });
	writeFileSync(LOG_FILE, "");
	const out = openSync(LOG_FILE, "a");
	const logs: ChildProcess = spawn("npx", ["convex", "logs", "--jsonl"], {
		cwd: backendDir,
		stdio: ["ignore", out, "ignore"],
	});
	await new Promise((resolve) => setTimeout(resolve, 4_000));
	return () => {
		logs.kill();
	};
}
