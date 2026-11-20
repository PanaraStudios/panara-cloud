import type { JobTarget } from "../handlers/types";
import { LocalHost } from "./local";
import { SshHost } from "./ssh";
import type { Host } from "./types";

export type { ExecOptions, ExecResult, Host } from "./types";
export { HostCommandError } from "./types";

export const connectHost = async (
	target: JobTarget,
	signal?: AbortSignal,
): Promise<Host> =>
	target.type === "local" ? new LocalHost() : SshHost.connect(target, signal);

type ConnectHook = (host: Host, serverId: string) => Promise<void>;
let onFirstConnect: ConnectHook | undefined;
const connectedServers = new Set<string>();

// Runs once per server per agent process, before the first job on it (e.g.
// rolling the monitoring collector after an upgrade). Failures are the
// hook's to report; they never fail the job.
export const setFirstConnectHook = (hook: ConnectHook) => {
	onFirstConnect = hook;
};

// Runs `fn` with a connected host and always closes the connection.
export const withHost = async <T>(
	target: JobTarget,
	signal: AbortSignal | undefined,
	fn: (host: Host) => Promise<T>,
): Promise<T> => {
	const host = await connectHost(target, signal);
	if (target.type === "ssh" && onFirstConnect) {
		if (!connectedServers.has(target.serverId)) {
			connectedServers.add(target.serverId);
			await onFirstConnect(host, target.serverId).catch(() => {});
		}
	}
	try {
		return await fn(host);
	} finally {
		host.close();
	}
};
