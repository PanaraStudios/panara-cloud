"use client";

import { api } from "@panara-cloud/backend/api";
import type { Doc, Id } from "@panara-cloud/backend/dataModel";
import { isConnectionFailure } from "@panara-cloud/backend/serverState";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { LOCAL_SERVER_ID } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { useParams } from "@/lib/router";

export const LOCAL_SERVER_NAME = "Panara Cloud host";

export type ServerRef = {
	/** The id as it appears in the URL (`local` for the panel host). */
	routeId: string;
	isLocal: boolean;
	/** What the ported Docker components take: undefined means the panel host. */
	serverId: string | undefined;
	/** What terminals and live sessions take: "local" for the panel host. */
	terminalId: string;
	name: string | undefined;
	ipAddress: string | undefined;
	server: FunctionReturnType<typeof api.servers.get> | undefined;
	/** undefined while loading, false when the server doesn't exist. */
	found: boolean | undefined;
	/** The member's role doesn't include servers (or, for the panel host,
	    they are not the instance administrator): nothing was asked for. */
	denied: boolean;
};

export function useServerRef(routeId?: string): ServerRef {
	const params = useParams<{ serverId: string }>();
	const id = decodeURIComponent(routeId ?? params.serverId ?? "");
	const isLocal = id === LOCAL_SERVER_ID;
	const canRead = usePermissions().server.read;
	const server = useQuery(
		api.servers.get,
		isLocal || !id || !canRead ? "skip" : { serverId: id as Id<"servers"> },
	);
	const isAdmin = useQuery(
		api.infra.webServer.isInstanceAdmin,
		isLocal ? {} : "skip",
	);
	const web = useQuery(api.infra.webServer.get, isLocal ? {} : "skip");
	return {
		routeId: id,
		isLocal,
		serverId: isLocal ? undefined : id,
		terminalId: isLocal ? LOCAL_SERVER_ID : id,
		name: isLocal ? LOCAL_SERVER_NAME : server?.name,
		ipAddress: isLocal ? (web?.serverIp ?? undefined) : server?.ipAddress,
		server: isLocal ? null : server,
		found: isLocal
			? isAdmin
			: !canRead
				? false
				: server === undefined
					? undefined
					: server !== null,
		denied: isLocal ? isAdmin === false : !canRead,
	};
}

export type ServerStatus = {
	label:
		| "Inactive"
		| "No SSH key"
		| "Not set up"
		| "Ready"
		| "Needs attention"
		| "Unreachable";
	tone: "success" | "destructive" | "warning" | "secondary";
	/** The muted line under the status in the servers table. */
	note?: string;
};

const firstLine = (text: string) =>
	text
		.split("\n")
		.find((line) => line.trim())
		?.trim()
		.slice(0, 80);

export function serverStatus(
	server: Pick<Doc<"servers">, "serverStatus" | "sshKeyId" | "lastValidation">,
): ServerStatus {
	if (server.serverStatus === "inactive")
		return { label: "Inactive", tone: "secondary" };
	if (!server.sshKeyId) return { label: "No SSH key", tone: "warning" };
	if (!server.lastValidation) return { label: "Not set up", tone: "warning" };
	if (server.lastValidation.ok) return { label: "Ready", tone: "success" };
	const note = firstLine(server.lastValidation.details);
	return isConnectionFailure(server.lastValidation.details)
		? { label: "Unreachable", tone: "destructive", note }
		: {
				label: "Needs attention",
				tone: "warning",
				note: server.lastValidation.details
					.split("\n")
					.find((line) => line.endsWith(": unavailable"))
					?.replace(": unavailable", " missing"),
			};
}

/** Not set up yet: only Overview, Terminal and Settings make sense. */
export const needsSetup = (status: ServerStatus) =>
	status.label === "Not set up" || status.label === "No SSH key";
