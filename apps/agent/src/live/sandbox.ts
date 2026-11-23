import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type Dockerode from "dockerode";
import type { Host } from "../host/types";
import { PANARA_CLOUD_LABEL } from "../lib/constants";
import { quote } from "../lib/shell";
import type { LiveConnection } from "./connection";
import {
	FileError,
	listContainerDir,
	normalizePath,
	readContainerFile,
} from "./files";
import { CLOSE } from "./protocol";
import {
	errorMessage,
	type SessionContext,
	type SessionHandler,
} from "./session";
import { packEntry } from "./tar";

export const SANDBOX_LABEL = "panara-cloud.sandbox";
export const SANDBOX_ID_LABEL = "panara-cloud.sandbox.id";
export const SANDBOX_ISOLATED_NETWORK = "panara-cloud-sandboxes-isolated";
export const SANDBOX_INTERNET_NETWORK = "panara-cloud-sandboxes";
const STATE_DIR = "/.panara-cloud";
const ACTIVITY_FILE = `${STATE_DIR}/activity`;
const TIMEOUT_FILE = `${STATE_DIR}/timeout`;
const ROOT_USER = "0:0";
const IDLE_CHECK_SECONDS = 5;
const MARKER_ENV = "PANARA_CLOUD_EXEC_ID";
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EXEC_OUTPUT = 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const MAX_EXEC_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 2000;
export const TIMEOUT_EXIT_CODE = 124;
const GONE_TOKEN = "__PANARA_CLOUD_SANDBOX_GONE__";
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type NetworkMode = "isolated" | "internet";

export type SandboxSpec = {
	sandboxId: string;
	organizationId: string;
	image: string;
	cpu: number;
	memoryMb: number;
	pidsLimit: number;
	networkMode: NetworkMode;
	env: string | null;
	workdir: string;
	timeoutMs: number;
	deadlineAt: number;
	runtime: string | null;
};

export const sandboxContainerName = (sandboxId: string) =>
	`panara-cloud-sandbox-${sandboxId}`;

export const sandboxNetworkName = (mode: NetworkMode) =>
	mode === "internet" ? SANDBOX_INTERNET_NETWORK : SANDBOX_ISOLATED_NETWORK;

const timeoutSeconds = (timeoutMs: number) => Math.ceil(timeoutMs / 1000);

// The container's main process sleeps until the deadline and kills itself
// after `timeout` seconds without activity (any exec touches the activity
// file).
export const lifetimeCommand = (deadlineAt: number, timeoutMs: number) => {
	const deadline = Math.floor(deadlineAt / 1000);
	const tick = IDLE_CHECK_SECONDS;
	const script = [
		`mkdir -p ${STATE_DIR} 2>/dev/null`,
		`echo ${timeoutSeconds(timeoutMs)} 2>/dev/null > ${TIMEOUT_FILE}`,
		`echo 0 2>/dev/null > ${ACTIVITY_FILE}`,
		`chmod 666 ${ACTIVITY_FILE} 2>/dev/null`,
		"(",
		"idle=0",
		`while sleep ${tick}; do`,
		`x=; read -r x 2>/dev/null < ${ACTIVITY_FILE}`,
		`if [ "$x" = 1 ]; then echo 0 2>/dev/null > ${ACTIVITY_FILE}; idle=0; else idle=$((idle + ${tick})); fi`,
		`i=; read -r i 2>/dev/null < ${TIMEOUT_FILE}`,
		`case "$i" in ''|*[!0-9]*) continue;; esac`,
		`if [ "$idle" -ge "$i" ]; then kill $$; exit 0; fi`,
		"done",
		") &",
		`exec sleep $(( ${deadline} - $(date +%s) ))`,
	];
	return ["sh", "-c", script.join("\n")];
};

export const timeoutCommand = (timeoutMs: number) =>
	`echo ${timeoutSeconds(timeoutMs)} > ${TIMEOUT_FILE} && echo 1 > ${ACTIVITY_FILE}`;

export const withActivity = (cmd: string) =>
	`echo 1 2>/dev/null > ${ACTIVITY_FILE}; ${cmd}`;

export const parseEnvLines = (env: string | null): string[] =>
	(env ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#") && line.includes("="));

export const parseUser = (user: string): { uid: number; gid: number } => {
	const [uidPart, gidPart] = user.split(":");
	const uid = Number.parseInt(uidPart ?? "", 10);
	const gid = Number.parseInt(gidPart ?? uidPart ?? "", 10);
	if (!Number.isInteger(uid) || uid < 0) return { uid: 0, gid: 0 };
	return { uid, gid: Number.isInteger(gid) && gid >= 0 ? gid : uid };
};

export const containerOptions = (
	spec: SandboxSpec,
): Dockerode.ContainerCreateOptions => {
	const memory = Math.round(spec.memoryMb * 1024 * 1024);
	return {
		name: sandboxContainerName(spec.sandboxId),
		Image: spec.image,
		Entrypoint: [""],
		Cmd: lifetimeCommand(spec.deadlineAt, spec.timeoutMs),
		WorkingDir: spec.workdir,
		Env: [`HOME=${spec.workdir}`, ...parseEnvLines(spec.env)],
		User: ROOT_USER,
		Labels: {
			[PANARA_CLOUD_LABEL]: "true",
			[SANDBOX_LABEL]: "true",
			[SANDBOX_ID_LABEL]: spec.sandboxId,
			"panara-cloud.organization": spec.organizationId,
		},
		HostConfig: {
			Init: true,
			NanoCpus: Math.round(spec.cpu * 1e9),
			Memory: memory,
			MemorySwap: memory,
			PidsLimit: spec.pidsLimit,
			CapDrop: ["ALL"],
			SecurityOpt: ["no-new-privileges"],
			RestartPolicy: { Name: "no" },
			AutoRemove: true,
			LogConfig: {
				Type: "json-file",
				Config: { "max-size": "10m", "max-file": "1" },
			},
			NetworkMode: sandboxNetworkName(spec.networkMode),
			...(spec.runtime ? { Runtime: spec.runtime } : {}),
		},
	};
};

const statusCode = (error: unknown) =>
	(error as { statusCode?: number } | null)?.statusCode;

export const ensureImage = async (host: Host, image: string) => {
	const inspect = await host.exec(
		`docker image inspect ${quote(image)} >/dev/null 2>&1`,
	);
	if (inspect.code === 0) return;
	await host.run(`docker pull ${quote(image)}`);
};

// Sandboxes on the same network must not reach each other (icc off); the
// isolated network has no route out at all.
export const ensureNetwork = async (docker: Dockerode, mode: NetworkMode) => {
	const name = sandboxNetworkName(mode);
	let existing: {
		Options?: Record<string, string>;
		Containers?: Record<string, unknown>;
	} | null = null;
	try {
		existing = await docker.getNetwork(name).inspect();
	} catch (error) {
		if (statusCode(error) !== 404) throw error;
	}
	if (existing) {
		if (
			existing.Options?.["com.docker.network.bridge.enable_icc"] === "false"
		) {
			return name;
		}
		if (Object.keys(existing.Containers ?? {}).length > 0) {
			throw new Error(
				`Network ${name} allows traffic between containers and is in use`,
			);
		}
		await docker.getNetwork(name).remove();
	}
	try {
		await docker.createNetwork({
			Name: name,
			Driver: "bridge",
			Internal: mode === "isolated",
			CheckDuplicate: true,
			Options: { "com.docker.network.bridge.enable_icc": "false" },
			Labels: { [PANARA_CLOUD_LABEL]: "true", [SANDBOX_LABEL]: "true" },
		});
	} catch (error) {
		if (statusCode(error) !== 409) throw error;
	}
	return name;
};

// Without -a, `docker cp` applies the uid/gid from the tar headers (with -a
// it would chown to the container's user, root here), so files land owned
// by the sandbox user although the container has no CAP_CHOWN.
const copyTarCommand = (containerId: string, dir: string) =>
	`base64 -d | docker cp - ${quote(`${containerId}:${dir}`)}`;

type Runner = (
	command: string,
	input?: string,
) => Promise<{ code: number | null; output: string }>;

const hostRunner =
	(host: Host): Runner =>
	(command, input) =>
		host.exec(command, { input });

const connRunner =
	(conn: LiveConnection): Runner =>
	async (command, input) => {
		const result = await conn.run(command, { input });
		return { code: result.code, output: `${result.stdout}${result.stderr}` };
	};

const prepareWorkdir = async (
	run: Runner,
	containerId: string,
	workdir: string,
	user: string,
) => {
	const parent = posix.dirname(workdir);
	const name = posix.basename(workdir);
	if (!name) return;
	if (parent !== "/") {
		await run(
			`docker exec -u ${ROOT_USER} ${quote(containerId)} mkdir -p ${quote(parent)}`,
		);
	}
	const tar = packEntry({ name, type: "directory", ...parseUser(user) });
	const result = await run(
		copyTarCommand(containerId, parent),
		tar.toString("base64"),
	);
	if (result.code !== 0) {
		throw new Error(`Could not create ${workdir}: ${result.output.trim()}`);
	}
};

export class SandboxExitedError extends Error {
	constructor() {
		super(
			"The container exited right after starting. Sandbox images must include sh, sleep and date.",
		);
	}
}

export const startSandboxContainer = async (
	host: Host,
	spec: SandboxSpec & { user: string },
	log: (line: string) => void,
): Promise<string> => {
	const docker = host.docker();
	log(`Ensuring image ${spec.image}`);
	await ensureImage(host, spec.image);
	await ensureNetwork(docker, spec.networkMode);
	const container = await docker.createContainer(containerOptions(spec));
	try {
		await container.start();
		await prepareWorkdir(
			hostRunner(host),
			container.id,
			spec.workdir,
			spec.user,
		);
		const running = await container
			.inspect()
			.then((info) => info.State.Running)
			.catch(() => false);
		if (!running) throw new SandboxExitedError();
		return container.id;
	} catch (error) {
		await container.remove({ force: true }).catch(() => {});
		throw error;
	}
};

export const removeSandboxContainer = async (host: Host, sandboxId: string) => {
	const name = sandboxContainerName(sandboxId);
	await host.exec(
		`docker stop -t 2 ${quote(name)} >/dev/null 2>&1; docker rm -f ${quote(name)} >/dev/null 2>&1; true`,
	);
};

export const setSandboxTimeout = async (
	host: Host,
	containerId: string,
	timeoutMs: number,
) => {
	await host.run(
		`docker exec -u ${ROOT_USER} ${quote(containerId)} sh -c ${quote(timeoutCommand(timeoutMs))}`,
	);
};

export const killScript = (marker: string) =>
	[
		"n=$(printf '\\nx'); n=${n%x}",
		"for f in /proc/[0-9]*/environ; do",
		"e=$(tr '\\0' '\\n' < \"$f\" 2>/dev/null) || continue",
		`case "$n$e$n" in *"\${n}${MARKER_ENV}=${marker}\${n}"*) ;; *) continue ;; esac`,
		'p=${f#/proc/}; kill -9 "${p%/environ}" 2>/dev/null',
		"done; true",
	].join("\n");

export type ExecOptions = {
	cmd: string;
	cwd?: string;
	env?: Record<string, string>;
	user: string;
	timeoutMs: number;
	onStdout?: (text: string) => void;
	onStderr?: (text: string) => void;
	signal?: AbortSignal;
};

export const validateEnv = (env: unknown): Record<string, string> => {
	if (env === undefined || env === null) return {};
	if (typeof env !== "object" || Array.isArray(env)) {
		throw new FileError("env must be an object");
	}
	const entries = Object.entries(env as Record<string, unknown>);
	if (entries.length > 200)
		throw new FileError("Too many environment variables");
	for (const [key, value] of entries) {
		if (
			!ENV_KEY.test(key) ||
			typeof value !== "string" ||
			/[\r\n\0]/.test(value)
		) {
			throw new FileError(`Invalid environment variable: ${key}`);
		}
	}
	return env as Record<string, string>;
};

// Runs a command in the sandbox through the docker CLI. Env goes through an
// fd so values never show up in a process list.
export const execScript = (
	containerId: string,
	options: Pick<ExecOptions, "cmd" | "cwd" | "env" | "user">,
	marker: string,
) => {
	const delimiter = `PANARA_CLOUD_ENV_${randomUUID().replaceAll("-", "")}`;
	const container = quote(containerId);
	return [
		[
			"docker exec --env-file /dev/fd/3",
			...(options.cwd ? [`-w ${quote(options.cwd)}`] : []),
			`-u ${quote(options.user)}`,
			container,
			`sh -c ${quote(options.cmd)}`,
			`</dev/null 3<<'${delimiter}'`,
		].join(" "),
		...Object.entries(options.env ?? {}).map(([k, v]) => `${k}=${v}`),
		`${MARKER_ENV}=${marker}`,
		delimiter,
		"c=$?",
		`if [ "$c" -ne 0 ] && [ "$(docker container inspect -f '{{.State.Running}}' ${container} 2>/dev/null)" != true ]; then echo ${GONE_TOKEN} >&2; fi`,
		'exit "$c"',
	].join("\n");
};

export type ExecResult = {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	truncated: boolean;
	containerGone: boolean;
};

export const execInSandbox = async (
	conn: LiveConnection,
	containerId: string,
	options: ExecOptions,
): Promise<ExecResult> => {
	const marker = randomUUID();
	const proc = await conn.spawn(execScript(containerId, options, marker));
	const out: Buffer[] = [];
	const err: Buffer[] = [];
	let bytes = 0;
	let truncated = false;
	const capture =
		(into: Buffer[], emit?: (text: string) => void) => (data: Buffer) => {
			const text = data.toString("utf8").replace(`${GONE_TOKEN}\n`, "");
			if (text) emit?.(text);
			if (bytes >= MAX_EXEC_OUTPUT) {
				truncated = true;
				return;
			}
			into.push(data.subarray(0, MAX_EXEC_OUTPUT - bytes));
			bytes += data.length;
		};
	proc.on("stdout", capture(out, options.onStdout));
	proc.on("stderr", capture(err, options.onStderr));
	let timedOut = false;
	const kill = async () => {
		await conn
			.run(
				`docker exec -u ${quote(options.user)} -e ${MARKER_ENV}=kill-${marker} ${quote(containerId)} sh -c ${quote(killScript(marker))}`,
			)
			.catch(() => {});
		setTimeout(() => proc.kill(), KILL_GRACE_MS).unref();
	};
	const timer = setTimeout(() => {
		timedOut = true;
		void kill();
	}, options.timeoutMs);
	const onAbort = () => void kill();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const code = await new Promise<number | null>((resolve) => {
		proc.once("exit", resolve);
		proc.end();
	});
	clearTimeout(timer);
	options.signal?.removeEventListener("abort", onAbort);
	const stderr = Buffer.concat(err).toString("utf8");
	return {
		stdout: Buffer.concat(out).toString("utf8"),
		stderr: stderr.replace(`${GONE_TOKEN}\n`, ""),
		exitCode: timedOut ? TIMEOUT_EXIT_CODE : code,
		timedOut,
		truncated,
		containerGone: stderr.includes(GONE_TOKEN),
	};
};

export const writeSandboxFile = async (
	conn: LiveConnection,
	containerId: string,
	user: string,
	input: { path: string; content: Buffer; mode?: number },
) => {
	if (input.content.length > MAX_FILE_BYTES) {
		throw new FileError(`File exceeds the ${MAX_FILE_BYTES} byte limit`);
	}
	const dir = posix.dirname(input.path);
	const name = posix.basename(input.path);
	if (!name) throw new FileError("Path must point to a file");
	const run = connRunner(conn);
	const mkdir = await run(
		`docker exec -u ${quote(user)} ${quote(containerId)} sh -c ${quote(withActivity(`mkdir -p ${quote(dir)}`))}`,
	);
	if (mkdir.code !== 0) {
		throw new FileError(
			mkdir.output.trim() || `Unable to create directory ${dir}`,
		);
	}
	const tar = packEntry({
		name,
		type: "file",
		content: input.content,
		mode: input.mode,
		...parseUser(user),
	});
	const copy = await run(
		copyTarCommand(containerId, dir),
		tar.toString("base64"),
	);
	if (copy.code !== 0)
		throw new FileError(copy.output.trim() || "Write failed");
	return { path: input.path, size: input.content.length };
};

const decodeContent = (content: unknown, encoding: unknown) => {
	if (typeof content !== "string")
		throw new FileError("content must be a string");
	return encoding === "base64"
		? Buffer.from(content, "base64")
		: Buffer.from(content, "utf8");
};

const execTimeout = (value: unknown) => {
	if (value === undefined) return DEFAULT_EXEC_TIMEOUT_MS;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1000 || n > MAX_EXEC_TIMEOUT_MS) {
		throw new FileError(
			`timeoutMs must be between 1000 and ${MAX_EXEC_TIMEOUT_MS}`,
		);
	}
	return n;
};

// Exec and file operations on a running sandbox. One command runs at a
// time.
export const startSandbox = async (
	ctx: SessionContext,
): Promise<SessionHandler> => {
	const extra = ctx.redeemed.extra;
	if (extra.type !== "sandbox") throw new Error("Not a sandbox session");
	const { containerId, user, workdir } = extra;
	const sessionId = ctx.redeemed.sessionId;
	const abort = new AbortController();
	let queue = Promise.resolve();

	const touch = async () => {
		if (!(await ctx.services.touchSandbox(sessionId))) {
			ctx.close(CLOSE.ended, "Sandbox is no longer running");
			throw new FileError("Sandbox is no longer running");
		}
	};
	const gone = async () => {
		await ctx.services.sandboxGone(sessionId).catch(() => {});
		ctx.close(CLOSE.ended, "Sandbox container is gone");
	};

	const handle = async (
		id: string,
		op: string,
		payload: Record<string, unknown>,
	) => {
		await touch();
		switch (op) {
			case "exec": {
				if (
					typeof payload.cmd !== "string" ||
					!payload.cmd ||
					payload.cmd.length > 65_536
				) {
					throw new FileError("cmd must be a non-empty string");
				}
				const result = await execInSandbox(ctx.conn, containerId, {
					cmd: withActivity(payload.cmd),
					cwd: payload.cwd === undefined ? workdir : normalizePath(payload.cwd),
					env: validateEnv(payload.env),
					user,
					timeoutMs: execTimeout(payload.timeoutMs),
					onStdout: (data) => ctx.send({ type: "stdout", id, data }),
					onStderr: (data) => ctx.send({ type: "stderr", id, data }),
					signal: abort.signal,
				});
				ctx.send({
					type: "exit",
					id,
					code: result.exitCode,
					timedOut: result.timedOut,
					truncated: result.truncated,
				});
				if (result.containerGone) await gone();
				return;
			}
			case "writeFile": {
				const mode =
					payload.mode === undefined ? undefined : Number(payload.mode);
				if (
					mode !== undefined &&
					(!Number.isInteger(mode) || mode < 0 || mode > 0o7777)
				) {
					throw new FileError("Invalid mode");
				}
				const data = await writeSandboxFile(ctx.conn, containerId, user, {
					path: normalizePath(payload.path),
					content: decodeContent(payload.content, payload.encoding),
					mode,
				});
				ctx.send({ type: "result", id, ok: true, data });
				return;
			}
			case "readFile": {
				const file = await readContainerFile(
					ctx.conn,
					containerId,
					normalizePath(payload.path),
					{ maxBytes: MAX_FILE_BYTES },
				);
				const data =
					payload.encoding === "base64" && file.encoding === "utf8"
						? {
								...file,
								encoding: "base64",
								content: Buffer.from(file.content).toString("base64"),
							}
						: file;
				ctx.send({ type: "result", id, ok: true, data });
				return;
			}
			case "listFiles": {
				const path =
					payload.path === undefined ? workdir : normalizePath(payload.path);
				const data = await listContainerDir(ctx.conn, containerId, path, user);
				ctx.send({ type: "result", id, ok: true, data });
				return;
			}
			default:
				throw new FileError(`Unknown operation: ${op}`);
		}
	};

	return {
		onMessage: (message) => {
			if (message.type !== "request") return;
			queue = queue.then(() =>
				handle(message.id, message.op, message.payload).catch((error) =>
					ctx.send({
						type: "result",
						id: message.id,
						ok: false,
						error: errorMessage(error),
					}),
				),
			);
		},
		dispose: () => abort.abort(),
	};
};
