"use client";

import type { Id } from "@panara-cloud/backend/dataModel";
import { Eraser, Loader2, Play, Terminal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useLiveRpc } from "@/lib/host-data";
import type { LiveMessage } from "@/lib/live";
import { cn } from "@/lib/utils";

type Line = {
	kind: "cmd" | "stdout" | "stderr" | "exit" | "error" | "info";
	text: string;
};

type ExitFrame = { type: "exit"; code: number | null; timedOut?: boolean };

interface Props {
	sandboxId: string;
	enabled: boolean;
	workdir: string;
}

const lineClass: Record<Line["kind"], string> = {
	cmd: "text-primary font-semibold",
	stdout: "text-foreground",
	stderr: "text-orange-500",
	exit: "text-muted-foreground italic",
	error: "text-destructive",
	info: "text-muted-foreground",
};

export const SandboxConsole = ({ sandboxId, enabled, workdir }: Props) => {
	const [lines, setLines] = useState<Line[]>([]);
	const [command, setCommand] = useState("");
	const [running, setRunning] = useState(false);
	const outputRef = useRef<HTMLDivElement | null>(null);

	const append = useCallback((line: Line) => {
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
	}, [lines]);

	const run = () => {
		const cmd = command.trim();
		if (!cmd || !connected || running) return;
		append({ kind: "cmd", text: `$ ${cmd}` });
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
				append({
					kind: "exit",
					text: exit.timedOut
						? `[timed out, exit code ${exit.code}]`
						: `[exit code ${exit.code}]`,
				});
			})
			.catch((error: unknown) => {
				append({
					kind: "error",
					text: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => setRunning(false));
	};

	return (
		<Card className="bg-background">
			<CardHeader className="flex flex-row items-center justify-between">
				<CardTitle className="text-xl flex items-center gap-2">
					<Terminal className="size-5 text-muted-foreground" />
					Console
					<span className="text-xs font-normal text-muted-foreground">
						{enabled
							? connected
								? "connected"
								: "connecting..."
							: "sandbox is not running"}
					</span>
				</CardTitle>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setLines([])}
					disabled={lines.length === 0}
				>
					<Eraser className="size-4" />
					Clear
				</Button>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				<div
					ref={outputRef}
					className="h-[360px] overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap break-words"
				>
					{lines.length === 0 ? (
						<span className="text-muted-foreground">
							Commands run with `sh -c` inside {workdir}. Output streams here.
						</span>
					) : (
						lines.map((line, index) => (
							<div key={index} className={cn(lineClass[line.kind])}>
								{line.text}
							</div>
						))
					)}
				</div>
				<form
					className="flex gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						run();
					}}
				>
					<Input
						value={command}
						onChange={(event) => setCommand(event.target.value)}
						placeholder="echo hello"
						className="font-mono"
						disabled={!enabled || !connected}
						autoComplete="off"
					/>
					<Button type="submit" disabled={!enabled || !connected || running}>
						{running ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							<Play className="size-4" />
						)}
						Run
					</Button>
				</form>
			</CardContent>
		</Card>
	);
};
