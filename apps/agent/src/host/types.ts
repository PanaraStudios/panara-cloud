import type Dockerode from "dockerode";

export type ExecOptions = {
	onOutput?: (text: string) => void;
	signal?: AbortSignal;
	// Written to the command's stdin, e.g. a script or file contents.
	input?: string;
};

export type ExecResult = { code: number | null; output: string };

// A machine the agent operates on: the panel host itself or a server over SSH.
// Commands run through `bash -c`, so callers must quote untrusted values
// (see `quote` in ../lib/shell.ts).
export interface Host {
	readonly kind: "local" | "ssh";
	readonly label: string;
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;
	// Like exec, but throws HostCommandError on a non-zero exit code.
	run(command: string, options?: ExecOptions): Promise<string>;
	writeFile(path: string, content: string, mode?: number): Promise<void>;
	readFile(path: string): Promise<string | null>;
	docker(): Dockerode;
	close(): void;
}

export class HostCommandError extends Error {
	constructor(
		readonly command: string,
		readonly code: number | null,
		readonly output: string,
	) {
		super(
			`Command failed with exit code ${code}: ${command.split("\n")[0]?.slice(0, 200)}`,
		);
	}
}
