"use client";

import { Terminal } from "@xterm/xterm";
import React, { useEffect, useRef } from "react";
import { FitAddon } from "xterm-addon-fit";
import { errorMessage } from "@/lib/auth/errors";
import "@xterm/xterm/css/xterm.css";
import { api } from "@panara-cloud/backend/api";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { useAction } from "convex/react";
import { useTheme } from "next-themes";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type LiveMessage, liveSocketUrl } from "@/lib/live";
import { fixMacOsAltKeys } from "@/lib/terminal-keyboard";
import { terminalTheme } from "@/lib/terminal-theme";
import { useHostScope } from "../logs/use-live-scope";

interface Props {
	id: string;
	containerId?: string;
	serverId?: string;
	serviceId?: string;
	/** Controlled shell; hides the built-in bash / sh picker. */
	shell?: "bash" | "sh";
	/** Classes of the terminal area (a full page passes its own height). */
	className?: string;
	onStatusChange?: (status: "connecting" | "open" | "closed") => void;
	/** The shell process ended with this exit code. */
	onExit?: (code: number | null) => void;
}

// Sentinel the container-picker modal renders with before a real container
// is selected/auto-selected — never worth opening a connection for.
const PLACEHOLDER_CONTAINER_ID = "select-a-container";

export const DockerTerminal: React.FC<Props> = ({
	id,
	containerId,
	serverId,
	serviceId: _serviceId,
	shell,
	className,
	onStatusChange,
	onExit,
}) => {
	const termRef = useRef(null);
	const exitRef = useRef(onExit);
	exitRef.current = onExit;
	const [pickedWay, setActiveWay] = React.useState<string | undefined>("bash");
	const activeWay = shell ?? pickedWay;
	const statusRef = useRef(onStatusChange);
	statusRef.current = onStatusChange;
	const { resolvedTheme } = useTheme();
	const openSession = useAction(api.live.sessions.open);
	const scope = useHostScope(serverId);
	const scopeKey = JSON.stringify(scope);
	useEffect(() => {
		if (!containerId || containerId === PLACEHOLDER_CONTAINER_ID) {
			return;
		}

		let cancelled = false;
		let term: Terminal | null = null;
		let ws: WebSocket | null = null;
		let resizeObserver: ResizeObserver | null = null;

		// Deferred a frame so React StrictMode's dev-only phantom mount+cleanup
		// (which runs synchronously, before anything paints) never creates a
		// terminal in the first place — dodges a known xterm.js dispose race
		// (xtermjs/xterm.js#5011) where a deferred internal callback outlives
		// term.dispose() and reads renderer state that's already gone.
		const frame = requestAnimationFrame(() => {
			if (cancelled) return;

			const container = document.getElementById(id);
			if (container) {
				container.innerHTML = "";
			}
			term = new Terminal({
				cursorBlink: true,
				lineHeight: 1.4,
				convertEol: true,
				theme: terminalTheme(resolvedTheme),
			});
			const addonFit = new FitAddon();
			const clipboardAddon = new ClipboardAddon();
			term.loadAddon(clipboardAddon);
			fixMacOsAltKeys(term);
			// @ts-expect-error
			term.open(termRef.current);
			term.loadAddon(addonFit);
			addonFit.fit();

			const terminal = term;
			const shell = activeWay === "sh" ? "sh" : "bash";
			statusRef.current?.("connecting");
			openSession({
				request: {
					kind: "containerTerminal",
					scope: JSON.parse(scopeKey),
					containerId,
					shell,
				},
			})
				.then((opened) => {
					if (cancelled) return;
					const url = new URL(liveSocketUrl(opened));
					url.searchParams.set("cols", String(terminal.cols));
					url.searchParams.set("rows", String(terminal.rows));
					const socket = new WebSocket(url.toString());
					ws = socket;
					socket.onopen = () =>
						socket.send(
							JSON.stringify({
								type: "resize",
								cols: terminal.cols,
								rows: terminal.rows,
							}),
						);
					socket.onmessage = (event) => {
						let message: LiveMessage;
						try {
							message = JSON.parse(String(event.data)) as LiveMessage;
						} catch {
							terminal.write(String(event.data));
							return;
						}
						if (message.type === "data") terminal.write(message.data);
						else if (message.type === "exit") exitRef.current?.(message.code);
						else if (message.type === "error") {
							terminal.write(`\r\n${message.message}\r\n`);
						}
					};
					socket.addEventListener("open", () => statusRef.current?.("open"));
					socket.onclose = (event) => {
						statusRef.current?.("closed");
						if (!cancelled && event.reason) {
							terminal.write(`\r\n${event.reason}\r\n`);
						}
					};
				})
				.catch((error: unknown) => {
					if (cancelled) return;
					statusRef.current?.("closed");
					terminal.write(
						`${error instanceof Error ? errorMessage(error) : String(error)}\r\n`,
					);
				});
			term.onData((data) => {
				if (ws && ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "input", data }));
				}
			});

			const sendResize = (cols: number, rows: number) => {
				if (ws && ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "resize", cols, rows }));
				}
			};
			term.onResize(({ cols, rows }) => sendResize(cols, rows));

			resizeObserver = new ResizeObserver(() => addonFit.fit());
			if (termRef.current) {
				resizeObserver.observe(termRef.current);
			}
		});

		return () => {
			cancelled = true;
			cancelAnimationFrame(frame);
			resizeObserver?.disconnect();
			ws?.close();
			term?.dispose();
		};
	}, [containerId, activeWay, id, scopeKey]);

	const hasContainer =
		!!containerId && containerId !== PLACEHOLDER_CONTAINER_ID;

	return (
		<div className="flex h-full flex-col gap-4">
			{hasContainer && !shell && (
				<div className="flex flex-col gap-2  mt-4">
					<span>
						Select way to connect to <b>{containerId}</b>
					</span>
					<Tabs value={activeWay} onValueChange={setActiveWay}>
						<TabsList>
							<TabsTrigger value="bash">Bash</TabsTrigger>
							<TabsTrigger value="sh">/bin/sh</TabsTrigger>
						</TabsList>
					</Tabs>
				</div>
			)}
			{hasContainer ? (
				<div className={className ?? "h-[420px] w-full"}>
					<div id={id} ref={termRef} className="h-full" />
				</div>
			) : (
				<div className="flex h-[420px] w-full items-center justify-center rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
					Select a container above to open a terminal. If none are listed, make
					sure the service is deployed and running.
				</div>
			)}
		</div>
	);
};
