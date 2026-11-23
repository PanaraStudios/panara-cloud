import Dockerode from "dockerode";
import { Client, type ClientChannel } from "ssh2";
import { quote } from "../lib/shell";
import { hostKeyCheck } from "./hostKey";
import { OutputTail } from "./output";
import {
	type ExecOptions,
	type ExecResult,
	type Host,
	HostCommandError,
} from "./types";

export type SshTarget = {
	host: string;
	port: number;
	username: string;
	privateKey: string;
	serverId?: string;
	hostKey?: string | null;
};

const CONNECT_TIMEOUT_MS = 20_000;
const KEEPALIVE = { keepaliveInterval: 15_000, keepaliveCountMax: 8 };

// Closing the channel doesn't stop a command: sshd keeps it open until the
// command exits, which a quiet one (a `docker pull` between layers) does
// only when it next writes and gets SIGPIPE. An SSH "signal" request can't
// help either: ssh2 drops it once stdin is ended, which exec always does,
// and sshd would pass it only to the session's first process. sshd starts
// each command in a session of its own, so the command first reports its
// process group on stderr, and a cancel signals that group over a second
// channel.
const GROUP_MARKER = "panara-cloud-pgid:";
const REPORT_GROUP = `pgid=; { read -r _ _ _ _ pgid _ < /proc/$$/stat; } 2>/dev/null || pgid=$(ps -o pgid= -p $$ 2>/dev/null); printf '${GROUP_MARKER}%s\\n' $pgid >&2`;
export const KILL_AFTER_MS = 3_000;
export const GIVE_UP_AFTER_MS = 6_000;

// Takes the group line out of a command's stderr. It comes before anything
// the command prints, though a login shell may print lines of its own first.
class GroupReport {
	private head = "";
	private seen = 0;
	private done = false;
	group: number | null = null;

	// Returns what of `text` is output to keep.
	take(text: string): string {
		if (this.done) return text;
		this.head += text;
		let kept = "";
		for (;;) {
			const newline = this.head.indexOf("\n");
			if (newline < 0) break;
			const line = this.head.slice(0, newline);
			this.head = this.head.slice(newline + 1);
			this.seen += newline + 1;
			if (line.startsWith(GROUP_MARKER)) {
				const group = Number(line.slice(GROUP_MARKER.length).trim());
				// Never 0 or 1: `kill -- -1` would signal every process of the user.
				if (Number.isInteger(group) && group > 1) this.group = group;
				this.done = true;
				return kept + this.head;
			}
			kept += `${line}\n`;
		}
		if (this.seen + this.head.length > 4096) {
			this.done = true;
			return kept + this.head;
		}
		return kept;
	}
}

export class SshHost implements Host {
	readonly kind = "ssh" as const;
	readonly label: string;
	private client: Dockerode | undefined;
	private seenKey: string | null = null;

	private constructor(
		private readonly connection: Client,
		private readonly target: SshTarget,
	) {
		this.label = `${target.username}@${target.host}:${target.port}`;
	}

	static connect(target: SshTarget, signal?: AbortSignal): Promise<SshHost> {
		const check = hostKeyCheck(target);
		return new Promise<SshHost>((resolve, reject) => {
			const connection = new Client();
			const onAbort = () => {
				connection.end();
				reject(new Error("Aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			connection
				.on("ready", () => {
					signal?.removeEventListener("abort", onAbort);
					resolve(new SshHost(connection, target));
				})
				.on("error", (error) => {
					signal?.removeEventListener("abort", onAbort);
					reject(check.error(error));
				})
				.connect({
					host: target.host,
					port: target.port,
					username: target.username,
					privateKey: target.privateKey,
					hostVerifier: check.verifier,
					readyTimeout: CONNECT_TIMEOUT_MS,
					...KEEPALIVE,
				});
		}).then(async (host) => {
			host.seenKey = check.seen();
			try {
				await check.recordIfNew();
			} catch (error) {
				host.close();
				throw error;
			}
			return host;
		});
	}

	exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		return new Promise((resolve, reject) => {
			this.connection.exec(
				`bash -c ${quote(`${REPORT_GROUP}; exec bash -c ${quote(command)}`)}`,
				(error, stream: ClientChannel) => {
					if (error) {
						reject(error);
						return;
					}
					const output = new OutputTail();
					const report = new GroupReport();
					const timers: ReturnType<typeof setTimeout>[] = [];
					let aborted = false;
					let signalled = false;
					let settled = false;
					const settle = (code: number | null) => {
						if (settled) return;
						settled = true;
						for (const timer of timers) clearTimeout(timer);
						options.signal?.removeEventListener("abort", onAbort);
						resolve({ code, output: output.value() });
					};
					const collect = (text: string) => {
						if (!text) return;
						output.append(text);
						options.onOutput?.(text);
					};
					const stopGroup = () => {
						const group = report.group;
						if (!aborted || signalled || group === null) return;
						signalled = true;
						this.signalGroup(group, "TERM");
						timers.push(
							setTimeout(() => this.signalGroup(group, "KILL"), KILL_AFTER_MS),
						);
					};
					const onAbort = () => {
						aborted = true;
						stopGroup();
						// Without a group to signal (no /proc and no ps there), or with
						// one that outlives KILL (another user's process, under sudo),
						// the job stops waiting for it.
						timers.push(
							setTimeout(() => {
								stream.close();
								settle(null);
							}, GIVE_UP_AFTER_MS),
						);
					};
					options.signal?.addEventListener("abort", onAbort, { once: true });
					stream.on("data", (data: Buffer) => collect(data.toString("utf8")));
					stream.stderr.on("data", (data: Buffer) => {
						collect(report.take(data.toString("utf8")));
						stopGroup();
					});
					stream.on("close", (code: number | null) => settle(code));
					stream.end(options.input ?? "");
				},
			);
		});
	}

	private signalGroup(group: number, signal: "TERM" | "KILL") {
		try {
			this.connection.exec(
				`kill -${signal} -- -${group} 2>/dev/null; true`,
				(error, stream) => {
					if (error) return;
					stream.resume();
					stream.stderr.resume();
					stream.end();
				},
			);
		} catch {
			// The connection is already closing; nothing more can be sent.
		}
	}

	async run(command: string, options?: ExecOptions): Promise<string> {
		const result = await this.exec(command, options);
		if (result.code !== 0) {
			throw new HostCommandError(command, result.code, result.output);
		}
		return result.output;
	}

	// Writes through the shell rather than SFTP so non-root users with sudo can
	// write into root-owned paths such as /etc/panara-cloud. The content lands in a
	// temp file first and is renamed into place, so watchers like Traefik never
	// see a half-written file.
	async writeFile(path: string, content: string, mode = 0o644): Promise<void> {
		const dir = path.slice(0, path.lastIndexOf("/")) || "/";
		const sudo = this.target.username === "root" ? "" : "sudo ";
		await this.run(
			[
				`${sudo}mkdir -p ${quote(dir)}`,
				`tmp=$(${sudo}mktemp ${quote(`${dir}/.panara-cloud-write.XXXXXX`)})`,
				`${sudo}tee "$tmp" >/dev/null`,
				`${sudo}chmod ${mode.toString(8)} "$tmp"`,
				`${sudo}mv -f "$tmp" ${quote(path)}`,
			].join(" && "),
			{ input: content },
		);
	}

	async readFile(path: string): Promise<string | null> {
		const sudo = this.target.username === "root" ? "" : "sudo ";
		const result = await this.exec(`${sudo}cat ${quote(path)}`);
		return result.code === 0 ? result.output : null;
	}

	docker(): Dockerode {
		this.client ??= new Dockerode({
			host: this.target.host,
			port: this.target.port,
			username: this.target.username,
			protocol: "ssh",
			// @ts-expect-error sshOptions is supported by docker-modem but missing from the types
			sshOptions: {
				privateKey: this.target.privateKey,
				// The SSH session above already learned or checked the key.
				hostVerifier: hostKeyCheck({
					...this.target,
					hostKey: this.target.hostKey ?? this.seenKey,
				}).verifier,
				...KEEPALIVE,
			},
		});
		return this.client;
	}

	close() {
		this.connection.end();
	}
}
