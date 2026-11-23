"use client";

import type { Id } from "@panara-cloud/backend/dataModel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "@/lib/auth/errors";
import { useLiveRpc } from "@/lib/host-data";
import type { LiveMessage } from "@/lib/live";
import { cn } from "@/lib/utils";
import { DarkWell } from "./server-ui";

export type ConsoleLine = {
	kind: "cmd" | "stdout" | "stderr" | "exit" | "error" | "info";
	text: string;
};

type ExitFrame = { type: "exit"; code: number | null; timedOut?: boolean };

const lineClass: Record<ConsoleLine["kind"], string> = {
	cmd: "text-terminal-foreground",
	stdout: "text-terminal-foreground/90",
	stderr: "text-warning",
	exit: "text-terminal-foreground/50",
	error: "text-danger",
	info: "text-terminal-foreground/50",
};

export const consoleText = (lines: ConsoleLine[]) =>
	lines.map((line) => line.text.replace(/\n$/, "")).join("\n");

/** The sandbox's exec session as a terminal: each command runs with
    `sh -c` and streams its output. */
export function SandboxTerminal({
	sandboxId,
	name,
	enabled,
	workdir,
	user,
	onLines,
	className,
}: {
	sandboxId: string;
	name: string;
	enabled: boolean;
	workdir: string;
	user: string;
	onLines?: (lines: ConsoleLine[]) => void;
	className?: string;
}) {
	const [lines, setLines] = useState<ConsoleLine[]>([]);
	const [command, setCommand] = useState("");
	const [running, setRunning] = useState(false);
	const outputRef = useRef<HTMLDivElement | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);

	const append = useCallback((line: ConsoleLine) => {
		setLines((prev) => {
			const last = prev[prev.length - 1];
			if (
				last &&
				(line.kind === "stdout" || line.kind === "stderr") &&
				last.kind === line.kind &&
				!last.text.endsWith("\n")
			) {
				return [...prev.slice(0, -1), { ...last, text: last.text + line.text }];
			}
			return [...prev, line];
		});
	}, []);

	useEffect(() => onLines?.(lines), [lines, onLines]);

	const request = useMemo(
		() =>
			enabled
				? { kind: "sandbox" as const, sandboxId: sandboxId as Id<"sandboxes"> }
				: null,
		[enabled, sandboxId],
	);
	const session = useLiveRpc(
		request,
		(message) => {
			if (message.type === "error")
				append({ kind: "error", text: message.message });
		},
		{ reconnect: true },
	);
	const connected = session.status === "open";
	const lastError = useRef<string | null>(null);
	useEffect(() => {
		if (
			(session.status === "closed" || session.status === "error") &&
			session.error &&
			session.error !== lastError.current
		) {
			lastError.current = session.error;
			append({ kind: "error", text: session.error });
		}
		if (session.status !== "open") setRunning(false);
	}, [session.status, session.error, append]);

	useEffect(() => {
		outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
	}, [lines, running]);

	const prompt = `${user === "root" || user.startsWith("0") ? "root" : "user"}@${name}:${workdir}${user === "root" || user.startsWith("0") ? "#" : "$"}`;

	const run = () => {
		const cmd = command.trim();
		if (!cmd || !connected || running) return;
		if (cmd === "clear") {
			setLines([]);
			setCommand("");
			return;
		}
		append({ kind: "cmd", text: cmd });
		setRunning(true);
		setCommand("");
		session
			.call<ExitFrame>("exec", { cmd }, (message: LiveMessage) => {
				if (message.type === "stdout")
					append({ kind: "stdout", text: message.data });
				else if (message.type === "stderr")
					append({ kind: "stderr", text: message.data });
			})
			.then((exit) => {
				if (exit.timedOut || exit.code) {
					append({
						kind: "exit",
						text: exit.timedOut
							? `timed out · exit ${exit.code}`
							: `exit ${exit.code}`,
					});
				}
			})
			.catch((error: unknown) => {
				append({
					kind: "error",
					text: error instanceof Error ? errorMessage(error) : String(error),
				});
			})
			.finally(() => {
				setRunning(false);
				inputRef.current?.focus();
			});
	};

	return (
		<DarkWell className={cn("flex min-h-0 flex-col", className)}>
			<div
				ref={outputRef}
				className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-5 py-4"
			>
				<div className="text-terminal-foreground/50">
					{enabled
						? connected
							? `Sandbox shell · sh -c in ${workdir} · everything here is deleted when the sandbox stops`
							: "Connecting…"
						: "The sandbox isn't running."}
				</div>
				{lines.map((line, index) =>
					line.kind === "cmd" ? (
						<div key={index}>
							<span className="text-success">{prompt}</span>{" "}
							<span className={lineClass.cmd}>{line.text}</span>
						</div>
					) : (
						<div key={index} className={lineClass[line.kind]}>
							{line.text.replace(/\n$/, "")}
						</div>
					),
				)}
				{enabled ? (
					<form
						method="post"
						className="flex items-center gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							run();
						}}
					>
						<span className="shrink-0 text-success">{prompt}</span>
						<input
							ref={inputRef}
							value={command}
							onChange={(event) => setCommand(event.target.value)}
							aria-label="Command"
							disabled={!connected || running}
							autoComplete="off"
							spellCheck={false}
							className="min-w-0 flex-1 bg-transparent text-terminal-foreground outline-none disabled:opacity-60"
						/>
					</form>
				) : null}
			</div>
		</DarkWell>
	);
}
