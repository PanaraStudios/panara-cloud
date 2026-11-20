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
				`bash -c ${quote(command)}`,
				(error, stream: ClientChannel) => {
					if (error) {
						reject(error);
						return;
					}
					const output = new OutputTail();
					const collect = (data: Buffer) => {
						const text = data.toString("utf8");
						output.append(text);
						options.onOutput?.(text);
					};
					const onAbort = () => {
						stream.signal("TERM");
						stream.close();
					};
					options.signal?.addEventListener("abort", onAbort, { once: true });
					stream.on("data", collect);
					stream.stderr.on("data", collect);
					stream.on("close", (code: number | null) => {
						options.signal?.removeEventListener("abort", onAbort);
						resolve({ code, output: output.value() });
					});
					stream.end(options.input ?? "");
				},
			);
		});
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
