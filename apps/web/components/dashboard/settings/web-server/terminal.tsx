"use client";

import { Terminal as XTerm } from "@xterm/xterm";
import type React from "react";
import { useEffect, useRef } from "react";
import { FitAddon } from "xterm-addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Id } from "@panara-cloud/backend/dataModel";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { useTheme } from "next-themes";
import { type LiveMessage, useOpenLiveSocket } from "@/lib/live";
import { useOrganization } from "@/lib/organization";
import { fixMacOsAltKeys } from "@/lib/terminal-keyboard";
import { terminalTheme } from "@/lib/terminal-theme";
import { getLocalServerData } from "./local-server-config";

export type TerminalStatus = "connecting" | "connected" | "closed";

interface Props {
	id: string;
	serverId: string;
	onStatus?: (status: TerminalStatus) => void;
}

export const Terminal: React.FC<Props> = ({ id, serverId, onStatus }) => {
	const onStatusRef = useRef(onStatus);
	onStatusRef.current = onStatus;
	const termRef = useRef<HTMLDivElement>(null);
	const { resolvedTheme } = useTheme();
	const { active } = useOrganization();
	const organizationId = active.id;
	const openSocket = useOpenLiveSocket();
	const openSocketRef = useRef(openSocket);
	openSocketRef.current = openSocket;
	useEffect(() => {
		let cancelled = false;
		let term: XTerm | null = null;
		let ws: WebSocket | null = null;
		let resizeObserver: ResizeObserver | null = null;

		const frame = requestAnimationFrame(() => {
			if (cancelled) return;

			const container = document.getElementById(id);
			if (container) {
				container.innerHTML = "";
			}
			term = new XTerm({
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

			const isLocal = serverId === "local";
			onStatusRef.current?.("connecting");
			const terminal = term;
			const sendResize = (cols: number, rows: number) => {
				if (ws && ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "resize", cols, rows }));
				}
			};
			openSocketRef
				.current({
					kind: "hostTerminal",
					organizationId,
					serverId: isLocal ? undefined : (serverId as Id<"servers">),
					local: isLocal ? getLocalServerData() : undefined,
				})
				.then((opened) => {
					if (cancelled) {
						opened.socket.close();
						return;
					}
					ws = opened.socket;
					ws.onopen = () => {
						onStatusRef.current?.("connected");
						sendResize(terminal.cols, terminal.rows);
					};
					ws.onmessage = (event) => {
						let message: LiveMessage;
						try {
							message = JSON.parse(String(event.data)) as LiveMessage;
						} catch {
							terminal.write(String(event.data));
							return;
						}
						if (message.type === "data") terminal.write(message.data);
						else if (message.type === "error") {
							terminal.write(`\r\n${message.message}\r\n`);
						} else if (message.type === "exit") {
							terminal.write("\r\n[session closed]\r\n");
							onStatusRef.current?.("closed");
						}
					};
					ws.onclose = (event) => {
						onStatusRef.current?.("closed");
						if (event.code !== 1000 && event.reason) {
							terminal.write(`\r\n${event.reason}\r\n`);
						}
					};
				})
				.catch((error: unknown) => {
					if (cancelled) return;
					onStatusRef.current?.("closed");
					terminal.write(
						`\r\n${error instanceof Error ? error.message : String(error)}\r\n`,
					);
				});

			term.onData((data) => {
				if (ws && ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "input", data }));
				}
			});
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
	}, [id, serverId, organizationId]);

	return (
		<div className="flex flex-col gap-4 h-full w-full">
			<div className="h-full w-full">
				<div id={id} ref={termRef} className="rounded-xl h-full w-full" />
			</div>
		</div>
	);
};
