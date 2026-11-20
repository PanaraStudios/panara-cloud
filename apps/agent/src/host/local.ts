import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import Dockerode from "dockerode";
import { OutputTail } from "./output";
import {
	type ExecOptions,
	type ExecResult,
	type Host,
	HostCommandError,
} from "./types";

export class LocalHost implements Host {
	readonly kind = "local" as const;
	readonly label = "local";
	private client: Dockerode | undefined;

	exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		return new Promise((resolve, reject) => {
			const child = spawn("bash", ["-c", command], {
				signal: options.signal,
				stdio: ["pipe", "pipe", "pipe"],
			});
			const output = new OutputTail();
			const collect = (data: Buffer) => {
				const text = data.toString("utf8");
				output.append(text);
				options.onOutput?.(text);
			};
			child.stdout.on("data", collect);
			child.stderr.on("data", collect);
			child.on("error", reject);
			child.on("close", (code) => resolve({ code, output: output.value() }));
			// A command that exits without reading stdin makes this write fail
			// with EPIPE; unhandled, that would crash the process.
			child.stdin.on("error", () => {});
			child.stdin.end(options.input ?? "");
		});
	}

	async run(command: string, options?: ExecOptions): Promise<string> {
		const result = await this.exec(command, options);
		if (result.code !== 0) {
			throw new HostCommandError(command, result.code, result.output);
		}
		return result.output;
	}

	async writeFile(path: string, content: string, mode = 0o644): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		const temp = `${dirname(path)}/.panara-cloud-write.${process.pid}.${randomUUID()}`;
		await writeFile(temp, content, { mode });
		await rename(temp, path);
	}

	async readFile(path: string): Promise<string | null> {
		try {
			return await readFile(path, "utf8");
		} catch {
			return null;
		}
	}

	docker(): Dockerode {
		this.client ??= new Dockerode();
		return this.client;
	}

	close() {}
}
