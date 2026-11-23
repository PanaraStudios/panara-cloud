// Moving a service's data between hosts. Each copy streams a tar from a
// command on the source host into a command on the target host through the
// agent, so the hosts never need to reach each other.
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { Client } from "ssh2";
import type { JobTarget } from "../handlers/types";
import { hostKeyCheck } from "../host/hostKey";
import type { Host } from "../host/types";
import { PANARA_CLOUD_LABEL } from "../lib/constants";
import { quote } from "../lib/shell";
import { DOCKER_PREAMBLE, SUDO_PREAMBLE } from "./shell";

const HELPER_IMAGE = "alpine:latest";
const PROGRESS_STEP = 64 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 20_000;
const MAX_ERROR_CHARS = 2_000;

export type TransferLog = { line: (text: string) => void };

type ProcessStream = {
	stdin: Writable;
	stdout: Readable;
	stderr: Readable;
	exit: Promise<number>;
	close: () => void;
};

const withPreamble = (command: string) =>
	`${SUDO_PREAMBLE}\n${DOCKER_PREAMBLE}\n${command}`;

// Host.exec only carries text; a transfer needs a binary pipe, so streams get
// their own process or SSH channel from the job target.
export const openProcessStream = (
	target: JobTarget,
	command: string,
): Promise<ProcessStream> => {
	const script = withPreamble(command);
	if (target.type === "local") {
		// Its own process group, so closing it also stops the commands bash
		// started; they would otherwise hold the pipes open until they exit.
		const child = spawn("bash", ["-c", script], {
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
		const exit = new Promise<number>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => resolve(code ?? 1));
		});
		return Promise.resolve({
			stdin: child.stdin,
			stdout: child.stdout,
			stderr: child.stderr,
			exit,
			close: () => {
				try {
					if (child.pid) process.kill(-child.pid, "SIGTERM");
				} catch {
					child.kill("SIGTERM");
				}
			},
		});
	}
	const check = hostKeyCheck(target);
	return new Promise((resolve, reject) => {
		const connection = new Client();
		connection
			.once("ready", () => {
				connection.exec(`bash -c ${quote(script)}`, (error, stream) => {
					if (error) {
						connection.end();
						reject(error);
						return;
					}
					let code = 1;
					stream.once("exit", (exitCode: number | null) => {
						code = exitCode ?? 1;
					});
					const exit = new Promise<number>((done) => {
						stream.once("close", () => {
							connection.end();
							done(code);
						});
					});
					resolve({
						stdin: stream,
						stdout: stream,
						stderr: stream.stderr,
						exit,
						close: () => {
							stream.close();
							connection.end();
						},
					});
				});
			})
			.once("error", (error) => {
				connection.end();
				reject(check.error(error));
			})
			.connect({
				host: target.host,
				port: target.port,
				username: target.username,
				privateKey: target.privateKey,
				hostVerifier: check.verifier,
				readyTimeout: CONNECT_TIMEOUT_MS,
				keepaliveInterval: 15_000,
				keepaliveCountMax: 8,
			});
	});
};

const collect = (stream: Readable) => {
	let text = "";
	stream.on("data", (chunk: Buffer) => {
		if (text.length < MAX_ERROR_CHARS) text += chunk.toString("utf8");
	});
	return () => text.trim().slice(0, MAX_ERROR_CHARS);
};

// Pipes the source command's stdout into the target command's stdin and
// resolves with the number of bytes moved. Either side failing (or the
// signal aborting) stops both.
export const pipeBetweenHosts = async (input: {
	source: { target: JobTarget; command: string };
	target: { target: JobTarget; command: string };
	onProgress?: (bytes: number) => void;
	signal?: AbortSignal;
}): Promise<number> => {
	if (input.signal?.aborted) throw new Error("Cancelled");
	const to = await openProcessStream(input.target.target, input.target.command);
	const targetError = collect(to.stderr);
	to.stdout.resume();
	to.stdin.on("error", () => {});
	let from: ProcessStream;
	try {
		from = await openProcessStream(input.source.target, input.source.command);
	} catch (error) {
		to.close();
		throw error;
	}
	const sourceError = collect(from.stderr);
	let bytes = 0;
	from.stdout.on("data", (chunk: Buffer) => {
		bytes += chunk.length;
		input.onProgress?.(bytes);
	});
	from.stdout.on("error", () => {});
	from.stdout.pipe(to.stdin);
	const onAbort = () => {
		from.close();
		to.close();
	};
	input.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const [sourceCode, targetCode] = await Promise.all([
			from.exit.then((code) => {
				if (code !== 0) to.close();
				return code;
			}),
			to.exit.then((code) => {
				if (code !== 0) from.close();
				return code;
			}),
		]);
		if (input.signal?.aborted) throw new Error("Cancelled");
		const failures = [
			sourceCode !== 0 &&
				`source exited with code ${sourceCode}: ${sourceError()}`,
			targetCode !== 0 &&
				`target exited with code ${targetCode}: ${targetError()}`,
		].filter(Boolean);
		if (failures.length > 0) throw new Error(failures.join("\n"));
		return bytes;
	} finally {
		input.signal?.removeEventListener("abort", onAbort);
	}
};

const label = quote(`${PANARA_CLOUD_LABEL}=true`);

export const volumeExportCommand = (volume: string) =>
	`$DOCKER run --rm --label ${label} -v ${quote(`${volume}:/data:ro`)} ${HELPER_IMAGE} tar -czf - --numeric-owner -C /data .`;

export const volumeImportCommand = (volume: string) =>
	`$DOCKER volume create ${quote(volume)} >/dev/null && $DOCKER run --rm -i --label ${label} -v ${quote(`${volume}:/data`)} ${HELPER_IMAGE} tar -xzf - --numeric-owner -C /data`;

// Bind mounts and service directories are often root-owned, hence $SUDO.
export const directoryExportCommand = (directory: string) =>
	`$SUDO tar -czf - --numeric-owner -C ${quote(directory)} .`;

export const directoryImportCommand = (directory: string) =>
	`$SUDO mkdir -p ${quote(directory)} && $SUDO tar -xzf - --numeric-owner -C ${quote(directory)}`;

export const formatBytes = (bytes: number) => {
	const mib = bytes / (1024 * 1024);
	if (mib < 1) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (mib < 1024) return `${mib.toFixed(1)} MiB`;
	return `${(mib / 1024).toFixed(2)} GiB`;
};

const runChecked = async (host: Host, command: string, signal?: AbortSignal) =>
	host.exec(withPreamble(command), { signal });

export const volumeExists = async (host: Host, volume: string) =>
	(
		await runChecked(
			host,
			`$DOCKER volume inspect ${quote(volume)} >/dev/null 2>&1`,
		)
	).code === 0;

export const directoryExists = async (host: Host, directory: string) =>
	(await runChecked(host, `$SUDO test -d ${quote(directory)}`)).code === 0;

// Pulled up front so pull progress never mixes into a data stream.
export const ensureHelperImage = async (host: Host, signal?: AbortSignal) => {
	const result = await runChecked(
		host,
		`$DOCKER image inspect ${HELPER_IMAGE} >/dev/null 2>&1 || $DOCKER pull -q ${HELPER_IMAGE} >/dev/null`,
		signal,
	);
	if (result.code !== 0) {
		throw new Error(
			`Could not pull ${HELPER_IMAGE} on ${host.label}: ${result.output.trim()}`,
		);
	}
};

// Compose projects create volumes Panara Cloud has no mount rows for.
export const listComposeVolumes = async (
	host: Host,
	appName: string,
): Promise<string[]> => {
	const project = quote(appName);
	const result = await runChecked(
		host,
		`$DOCKER volume ls -q --filter label=com.docker.compose.project=${project}; $DOCKER volume ls -q --filter label=com.docker.stack.namespace=${project}`,
	);
	return [
		...new Set(
			result.output
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(line)),
		),
	];
};

export type TransferEndpoint = { target: JobTarget; host: Host };

export type DataPlan = {
	volumes: string[];
	directories: string[];
	// Renames on the target, for copying between names on one host.
	renameVolume?: (name: string) => string;
	renameDirectory?: (path: string) => string;
};

const copy = async (
	what: string,
	source: { target: JobTarget; command: string },
	target: { target: JobTarget; command: string },
	log: TransferLog,
	signal?: AbortSignal,
) => {
	let reported = 0;
	const bytes = await pipeBetweenHosts({
		source,
		target,
		signal,
		onProgress: (transferred) => {
			if (transferred - reported >= PROGRESS_STEP) {
				reported = transferred;
				log.line(`  ${what}: ${formatBytes(transferred)} transferred`);
			}
		},
	});
	log.line(`  ${what}: done (${formatBytes(bytes)} compressed)`);
	return bytes;
};

// Copies the listed volumes and directories from source to target. Missing
// ones are skipped with a note; returns what was actually copied.
export const copyServiceData = async (
	source: TransferEndpoint,
	target: TransferEndpoint,
	plan: DataPlan,
	log: TransferLog,
	signal?: AbortSignal,
): Promise<{ volumes: string[]; directories: string[] }> => {
	const volumes: string[] = [];
	for (const volume of plan.volumes) {
		if (await volumeExists(source.host, volume)) volumes.push(volume);
		else
			log.line(`Skipping volume ${volume}: not found on ${source.host.label}`);
	}
	const directories: string[] = [];
	for (const directory of plan.directories) {
		if (await directoryExists(source.host, directory)) {
			directories.push(directory);
		} else {
			log.line(`Skipping ${directory}: not found on ${source.host.label}`);
		}
	}
	log.line(
		`Copying ${volumes.length} volume(s) and ${directories.length} director${directories.length === 1 ? "y" : "ies"}`,
	);
	if (volumes.length > 0) {
		await ensureHelperImage(source.host, signal);
		await ensureHelperImage(target.host, signal);
	}
	for (const volume of volumes) {
		const destination = plan.renameVolume?.(volume) ?? volume;
		log.line(`Copying volume ${volume}`);
		await copy(
			volume,
			{ target: source.target, command: volumeExportCommand(volume) },
			{ target: target.target, command: volumeImportCommand(destination) },
			log,
			signal,
		);
	}
	for (const directory of directories) {
		const destination = plan.renameDirectory?.(directory) ?? directory;
		log.line(`Copying ${directory}`);
		await copy(
			directory,
			{ target: source.target, command: directoryExportCommand(directory) },
			{ target: target.target, command: directoryImportCommand(destination) },
			log,
			signal,
		);
	}
	return { volumes, directories };
};

export const removeVolumesOnHost = async (
	host: Host,
	volumes: string[],
	log: TransferLog,
) => {
	for (const volume of volumes) {
		const result = await runChecked(
			host,
			`$DOCKER volume rm --force ${quote(volume)}`,
		);
		log.line(
			result.code === 0
				? `Removed volume ${volume}`
				: `Could not remove volume ${volume}: ${result.output.trim()}`,
		);
	}
};
