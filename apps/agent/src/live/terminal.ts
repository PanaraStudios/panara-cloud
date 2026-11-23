import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { paths } from "../lib/constants";
import { quote } from "../lib/shell";
import { connectSsh, LiveConnection, type LiveProcess } from "./connection";
import { assertContainerAccess } from "./ownership";
import { CLOSE, type RequestOf } from "./protocol";
import {
	errorMessage,
	type SessionContext,
	type SessionHandler,
	textForwarder,
} from "./session";

const LOCAL_KEY_PATH =
	process.env.LIVE_LOCAL_SSH_KEY ??
	`${paths.ssh}/auto_generated-panara-cloud-local`;

// The agent may run in a container, so the panel host terminal is an SSH
// login to the host.
const localSshHost = () =>
	process.env.LIVE_LOCAL_SSH_HOST ??
	(existsSync("/.dockerenv") ? "172.17.0.1" : "127.0.0.1");

const ensureLocalKey = async (): Promise<{
	privateKey: string;
	publicKey: string;
}> => {
	if (!existsSync(LOCAL_KEY_PATH)) {
		await mkdir(dirname(LOCAL_KEY_PATH), { recursive: true, mode: 0o700 });
		await promisify(execFile)("ssh-keygen", [
			"-t",
			"ed25519",
			"-f",
			LOCAL_KEY_PATH,
			"-N",
			"",
			"-C",
			"panara-cloud-local-access",
		]);
	}
	return {
		privateKey: await readFile(LOCAL_KEY_PATH, "utf8"),
		publicKey: (await readFile(`${LOCAL_KEY_PATH}.pub`, "utf8")).trim(),
	};
};

const allowLocalAccessCommand = (publicKey: string) =>
	[
		"mkdir -p $HOME/.ssh && chmod 700 $HOME/.ssh &&",
		"touch $HOME/.ssh/authorized_keys && chmod 600 $HOME/.ssh/authorized_keys &&",
		`echo ${quote(publicKey)} >> $HOME/.ssh/authorized_keys`,
	].join(" \\\n  ");

// Pipes a process to the socket: output out, keystrokes and resizes in.
const attach = (ctx: SessionContext, proc: LiveProcess): SessionHandler => {
	const forward = textForwarder((data) => ctx.send({ type: "data", data }));
	proc.on("stdout", forward);
	proc.on("stderr", forward);
	proc.once("exit", (code: number | null) => {
		ctx.send({ type: "exit", code });
		ctx.close(CLOSE.ended, "Process exited");
	});
	return {
		onMessage: (message) => {
			if (message.type === "input") proc.write(message.data);
			else if (message.type === "resize") proc.resize(message);
		},
		dispose: () => proc.kill(),
	};
};

export const startHostTerminal = async (
	ctx: SessionContext,
): Promise<SessionHandler> => {
	const extra = ctx.redeemed.extra;
	const local = extra.type === "hostTerminal" ? extra.local : null;
	if (ctx.conn.kind === "ssh") {
		return attach(ctx, await ctx.conn.shell(ctx.size));
	}
	if (!local) throw new Error("Missing local login settings");
	const key = await ensureLocalKey();
	let conn: LiveConnection;
	try {
		conn = LiveConnection.fromSsh(
			await connectSsh({
				host: localSshHost(),
				port: local.port,
				username: local.username,
				privateKey: key.privateKey,
			}),
		);
	} catch (error) {
		const level = (error as { level?: string }).level;
		ctx.send({
			type: "data",
			data:
				level === "client-authentication"
					? `Authentication failed. Run this on the panel host as ${local.username}, then reopen the terminal:\n\n${allowLocalAccessCommand(key.publicKey)}\n`
					: `SSH connection error: ${errorMessage(error)}\n`,
		});
		ctx.close(CLOSE.ended, "SSH login failed");
		return {};
	}
	const handler = attach(ctx, await conn.shell(ctx.size));
	return {
		onMessage: handler.onMessage,
		dispose: () => {
			handler.dispose?.();
			conn.close();
		},
	};
};

export const startContainerTerminal = async (
	ctx: SessionContext,
): Promise<SessionHandler> => {
	const request = ctx.redeemed.request as RequestOf<"containerTerminal">;
	const containerId = await assertContainerAccess(
		ctx.conn,
		request.containerId,
		ctx.redeemed.restriction,
	);
	if (ctx.conn.kind === "ssh") {
		const proc = await ctx.conn.spawn(
			`docker exec -it -w / ${quote(containerId)} ${quote(request.shell)}`,
			{ pty: ctx.size },
		);
		return attach(ctx, proc);
	}
	// Locally there is no PTY library, so use a Docker TTY exec (resizable).
	const exec = await ctx.conn
		.docker()
		.getContainer(containerId)
		.exec({
			Cmd: [request.shell],
			AttachStdin: true,
			AttachStdout: true,
			AttachStderr: true,
			Tty: true,
			WorkingDir: "/",
			Env: ["TERM=xterm-256color"],
		});
	const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
	const forward = textForwarder((data) => ctx.send({ type: "data", data }));
	stream.on("data", forward);
	stream.once("end", async () => {
		const info = await exec.inspect().catch(() => null);
		ctx.send({ type: "exit", code: info?.ExitCode ?? null });
		ctx.close(CLOSE.ended, "Process exited");
	});
	await exec.resize({ h: ctx.size.rows, w: ctx.size.cols }).catch(() => {});
	return {
		onMessage: (message) => {
			if (message.type === "input") stream.write(message.data);
			else if (message.type === "resize") {
				void exec.resize({ h: message.rows, w: message.cols }).catch(() => {});
			}
		},
		dispose: () => stream.destroy(),
	};
};
