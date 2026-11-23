"use client";

import { isConnectionFailure } from "@panara-cloud/backend/serverState";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { usePanelStatus } from "@/components/dashboard/settings/web-server/panel-actions";
import type { BadgeTone } from "@/components/ui-kit/primitives";
import { useSnapshot } from "@/lib/host-data";
import { usePermissions } from "@/lib/permissions";
import { StatusText } from "./server-ui";
import { needsSetup, type ServerRef, serverStatus } from "./use-server";

type Status = { tone: BadgeTone; label: string; hollow?: boolean };

type Slots = {
	status: Status | null;
	setStatus: (status: Status | null) => void;
	actions: HTMLElement | null;
	setActions: (element: HTMLElement | null) => void;
};

const HeaderContext = createContext<Slots | null>(null);

/** Lets a page under the server header fill its status and buttons. */
export function ServerHeaderSlots({ children }: { children: React.ReactNode }) {
	const [status, setStatus] = useState<Status | null>(null);
	const [actions, setActions] = useState<HTMLElement | null>(null);
	const slots = useMemo(
		() => ({ status, setStatus, actions, setActions }),
		[status, actions],
	);
	return <HeaderContext value={slots}>{children}</HeaderContext>;
}

/** "Deploy server · 142.93.18.40" with the address in mono. */
export function factsLine(parts: (string | undefined | null)[], ip?: string) {
	const text = parts.filter(Boolean).join(" · ");
	return (
		<>
			{text}
			{ip ? (
				<>
					{text ? " · " : ""}
					<span className="font-mono text-[13px]">{ip}</span>
				</>
			) : null}
		</>
	);
}

/** The server's status as every tab shows it: its record, sharpened by
    whether Docker answered when the header asked for the containers (once,
    on opening the server). The Overview reads the same, so the status
    doesn't change from tab to tab. */
function useKnownStatus(refInfo: ServerRef): Status {
	const permissions = usePermissions();
	const status = refInfo.server ? serverStatus(refInfo.server) : null;
	const setUp = refInfo.isLocal || (status !== null && !needsSetup(status));
	const containers = useSnapshot<unknown>(refInfo.serverId, "containers", {
		enabled: setUp && permissions.docker.read,
	});
	if (containers.error) {
		if (
			!refInfo.isLocal &&
			refInfo.server?.serverStatus !== "inactive" &&
			isConnectionFailure(containers.error)
		) {
			return { tone: "destructive", label: "Unreachable" };
		}
		if (!containers.data) {
			return { tone: "warning", label: "Docker not answering" };
		}
	}
	if (!status) return { tone: "success", label: "Ready" };
	return status.label === "Not set up"
		? { tone: "secondary", label: status.label, hollow: true }
		: { tone: status.tone, label: status.label };
}

/** The server's header, the same on every one of its pages: name, status as
    dot + word, one line of facts. The Overview refines the status and adds
    its buttons through `OverviewHeader`. */
export function ServerHeader({ refInfo }: { refInfo: ServerRef }) {
	const slots = useContext(HeaderContext);
	const known = useKnownStatus(refInfo);
	const { data: panel } = usePanelStatus();
	return (
		<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
			<div className="min-w-0 space-y-1">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<h1 className="truncate text-foreground text-h3">
						{refInfo.name ?? "Server"}
					</h1>
					<StatusText {...(slots?.status ?? known)} />
				</div>
				<p className="text-muted-foreground text-small">
					{factsLine(
						refInfo.isLocal
							? [
									"Panel host",
									panel?.version ? `Panara Cloud ${panel.version}` : null,
								]
							: [
									refInfo.server?.serverType === "build"
										? "Build server"
										: "Deploy server",
									refInfo.server?.description,
								],
						refInfo.ipAddress,
					)}
				</p>
			</div>
			<div
				ref={slots?.setActions}
				className="flex shrink-0 flex-wrap items-center gap-2 empty:hidden"
			/>
		</div>
	);
}

/** What the Overview knows beyond the server record: a sharper status
    ("Setting up", "Docker not answering") and the buttons for it. */
export function OverviewHeader({
	status,
	children,
}: {
	status: Status;
	children?: React.ReactNode;
}) {
	const slots = useContext(HeaderContext);
	const setStatus = slots?.setStatus;
	const { tone, label, hollow } = status;
	useEffect(() => {
		setStatus?.({ tone, label, hollow });
		return () => setStatus?.(null);
	}, [setStatus, tone, label, hollow]);
	return slots?.actions && children
		? createPortal(children, slots.actions)
		: null;
}
