import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import Dockerode from "dockerode";
import { Client, type ClientChannel } from "ssh2";
import type { JobTarget } from "../handlers/types";
import { hostKeyCheck } from "../host/hostKey";
import { quote } from "../lib/shell";

const CONNECT_TIMEOUT_MS = 20_000;
const KEEPALIVE = { keepaliveInterval: 15_000, keepaliveCountMax: 4 };
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;

export type SshLogin = {
	host: string;
	port: number;
	username: string;
	privateKey: string;
	serverId?: string;
	hostKey?: string | null;
};

export type RunResult = { code: number | null; stdout: string; stderr: string };

export type RunOptions = {
	input?: string | Buffer;
	maxOutputBytes?: number;
	signal?: AbortSignal;
};

export type PtySize = { cols: number; rows: number };

// A running process attached to a live session: a local child, or an SSH
// channel (optionally with a PTY). Emits "stdout", "stderr" (Buffer) and
// "exit" (code: number | null).
export class LiveProcess extends EventEmitter {
	private exited = false;

	constructor(
		private readonly handle: {
			write: (data: string | Buffer) => void;
			end: () => void;
			resize?: (size: PtySize) => void;
			kill: () => void;
		},
	) {
		super();
	}

	write(data: string | Buffer) {
		if (!this.exited) this.handle.write(data);
	}

	end() {
		if (!this.exited) this.handle.end();
	}

	resize(size: PtySize) {
		this.handle.resize?.(size);
	}

	kill() {
		if (!this.exited) this.handle.kill();
	}

	markExited(code: number | null) {
		if (this.exited) return;
		this.exited = true;
		this.emit("exit", code);
	}

	get done() {
		return this.exited;
	}
}

export const connectSsh = async (login: SshLogin): Promise<Client> => {
	const check = hostKeyCheck(login);
	const client = await new Promise<Client>((resolve, reject) => {
		const client = new Client();
		client
			.once("ready", () => resolve(client))
			.once("error", (error) => reject(check.error(error)))
			.connect({
				host: login.host,
				port: login.port,
				username: login.username,
				privateKey: login.privateKey,
				hostVerifier: check.verifier,
				readyTimeout: CONNECT_TIMEOUT_MS,
				...KEEPALIVE,
			});
	});
	try {
		await check.recordIfNew();
	} catch (error) {
		client.end();
		throw error;
	}
	return client;
};

const collect = (maxBytes: number) => {
	const chunks: Buffer[] = [];
	let size = 0;
	return {
		push(chunk: Buffer) {
			if (size >= maxBytes) return;
			const slice = chunk.subarray(0, maxBytes - size);
			chunks.push(slice);
			size += slice.length;
		},
		text: () => Buffer.concat(chunks).toString("utf8"),
	};
};

const channelProcess = (channel: ClientChannel, pty: boolean) => {
	const proc = new LiveProcess({
		write: (data) => channel.write(data),
		end: () => channel.end(),
		resize: pty
			? (size) => channel.setWindow(size.rows, size.cols, 0, 0)
			: undefined,
		kill: () => {
			channel.signal("KILL");
			channel.close();
		},
	});
	let code: number | null = null;
	channel.on("data", (data: Buffer) => proc.emit("stdout", data));
	channel.stderr.on("data", (data: Buffer) => proc.emit("stderr", data));
	channel.on("exit", (exitCode: number | null) => {
		code = exitCode;
	});
	channel.on("close", () => proc.markExited(code));
	return proc;
};

const childProcess = (child: ChildProcess) => {
	const proc = new LiveProcess({
		write: (data) => child.stdin?.write(data),
		end: () => child.stdin?.end(),
		kill: () => {
			// Detached children lead their own process group, so pipelines
			// (`docker logs | grep`) die together.
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		},
	});
	child.stdout?.on("data", (data: Buffer) => proc.emit("stdout", data));
	child.stderr?.on("data", (data: Buffer) => proc.emit("stderr", data));
	child.on("error", (error) => {
		proc.emit("stderr", Buffer.from(`${error.message}\n`));
		proc.markExited(null);
	});
	child.on("close", (code) => proc.markExited(code));
	return proc;
};

// One host a live session talks to: the panel host (local processes and the
// Docker socket) or a server over a dedicated SSH connection.
export class LiveConnection {
	private dockerClient: Dockerode | undefined;
	private readonly processes = new Set<LiveProcess>();

	private constructor(
		readonly kind: "local" | "ssh",
		private readonly ssh: Client | null,
	) {}

	static async open(target: JobTarget): Promise<LiveConnection> {
		if (target.type === "local") return new LiveConnection("local", null);
		return new LiveConnection("ssh", await connectSsh(target));
	}

	static fromSsh(client: Client): LiveConnection {
		return new LiveConnection("ssh", client);
	}

	private track(proc: LiveProcess) {
		this.processes.add(proc);
		proc.once("exit", () => this.processes.delete(proc));
		return proc;
	}

	// Starts `command` under bash. With `pty`, SSH allocates a terminal so the
	// remote process gets SIGHUP when the channel closes; output is merged.
	async spawn(command: string, options: { pty?: PtySize } = {}) {
		if (!this.ssh) {
			const child = spawn("bash", ["-c", command], {
				detached: true,
				stdio: ["pipe", "pipe", "pipe"],
			});
			return this.track(childProcess(child));
		}
		const ssh = this.ssh;
		const channel = await new Promise<ClientChannel>((resolve, reject) => {
			ssh.exec(
				`bash -c ${quote(command)}`,
				options.pty ? { pty: { ...options.pty, term: "xterm-256color" } } : {},
				(error, stream) => (error ? reject(error) : resolve(stream)),
			);
		});
		return this.track(channelProcess(channel, Boolean(options.pty)));
	}

	// An interactive login shell (SSH only).
	async shell(size: PtySize) {
		if (!this.ssh) throw new Error("Interactive shells need an SSH connection");
		const ssh = this.ssh;
		const channel = await new Promise<ClientChannel>((resolve, reject) => {
			ssh.shell({ ...size, term: "xterm-256color" }, (error, stream) =>
				error ? reject(error) : resolve(stream),
			);
		});
		return this.track(channelProcess(channel, true));
	}

	async run(command: string, options: RunOptions = {}): Promise<RunResult> {
		const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
		const proc = await this.spawn(command);
		const stdout = collect(max);
		const stderr = collect(64 * 1024);
		proc.on("stdout", (data: Buffer) => stdout.push(data));
		proc.on("stderr", (data: Buffer) => stderr.push(data));
		const onAbort = () => proc.kill();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const code = await new Promise<number | null>((resolve) => {
			proc.once("exit", resolve);
			if (options.input !== undefined) proc.write(options.input);
			proc.end();
		});
		options.signal?.removeEventListener("abort", onAbort);
		return { code, stdout: stdout.text(), stderr: stderr.text() };
	}

	async runOk(command: string, options?: RunOptions): Promise<string> {
		const result = await this.run(command, options);
		if (result.code !== 0) {
			throw new Error(
				(result.stderr || result.stdout).trim().slice(0, 500) ||
					`Command failed with exit code ${result.code}`,
			);
		}
		return result.stdout;
	}

	// Docker API on the panel host (used for PTY execs, which need resize).
	docker(): Dockerode {
		if (this.ssh) throw new Error("Docker API is only used locally");
		this.dockerClient ??= new Dockerode();
		return this.dockerClient;
	}

	// A TCP stream to `port` on the host itself (through SSH for servers).
	async forward(port: number, localHost = "127.0.0.1"): Promise<Duplex> {
		if (!this.ssh) {
			return await new Promise((resolve, reject) => {
				const socket = netConnect({ host: localHost, port });
				socket.once("connect", () => resolve(socket));
				socket.once("error", reject);
			});
		}
		const ssh = this.ssh;
		return await new Promise((resolve, reject) => {
			ssh.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (error, stream) =>
				error ? reject(error) : resolve(stream),
			);
		});
	}

	close() {
		for (const proc of this.processes) proc.kill();
		this.processes.clear();
		this.ssh?.end();
	}
}
