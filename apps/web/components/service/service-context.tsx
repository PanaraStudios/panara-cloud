"use client";

import { createContext, useContext, useMemo } from "react";
import {
	type ApplicationView,
	useApplication,
} from "@/components/dashboard/application/use-application";
import {
	type ComposeData,
	useCompose,
} from "@/components/dashboard/compose/use-compose";
import {
	type DatabaseData,
	type DatabaseType,
	useDatabase,
} from "@/components/dashboard/database/use-database";
import { sourceOfGitUrl } from "@/components/icons/service-icons";
import type { BadgeTone } from "@/components/ui-kit/primitives";
import {
	type DatabaseKind,
	isDatabaseKind,
	type ServiceKind,
	type ServiceRef,
	serviceTarget,
} from "@/lib/navigation";
import { type PendingChanges, usePendingChanges } from "./use-pending-changes";

export type ServiceStatus = "idle" | "running" | "done" | "error";

export type ServiceInfo = {
	ref: ServiceRef;
	kind: ServiceKind;
	family: "application" | "compose" | "database";
	id: string;
	name: string;
	description: string | null;
	appName: string;
	status: ServiceStatus;
	serverId: string | null;
	serverName: string | null;
	icon: string | null;
	application?: ApplicationView;
	compose?: ComposeData;
	database?: DatabaseData;
};

type ServiceContextValue = {
	service: ServiceInfo;
	pending: PendingChanges | undefined;
};

const ServiceContext = createContext<ServiceContextValue | null>(null);

/** The service of the current workspace route (inside its layout). */
export function useService(): ServiceContextValue {
	const value = useContext(ServiceContext);
	if (!value) throw new Error("useService outside the service layout");
	return value;
}

export function ServiceProvider({
	service,
	children,
}: {
	service: ServiceInfo;
	children: React.ReactNode;
}) {
	const pending = usePendingChanges(service.kind, service.id);
	const value = useMemo(() => ({ service, pending }), [service, pending]);
	return <ServiceContext value={value}>{children}</ServiceContext>;
}

/** Loads the route's service in one shape; undefined while loading, null
    when gone. Pass a memoized `ref`. */
export function useServiceInfo(
	ref: ServiceRef,
): ServiceInfo | null | undefined {
	const { kind, id } = ref;
	const application = useApplication(kind === "application" ? id : undefined);
	const compose = useCompose(kind === "compose" ? id : undefined);
	const database = useDatabase(isDatabaseKind(kind) ? id : undefined);
	return useMemo(() => {
		const base = { ref, kind, id, family: serviceTarget(kind, id).kind };
		if (kind === "application") {
			if (!application) return application;
			return {
				...base,
				name: application.name,
				description: application.description ?? null,
				appName: application.appName,
				status: application.applicationStatus,
				serverId: application.serverId ?? null,
				serverName: application.server?.name ?? null,
				icon: application.icon ?? null,
				application,
			};
		}
		if (kind === "compose") {
			if (!compose) return compose;
			return {
				...base,
				name: compose.name,
				description: compose.description ?? null,
				appName: compose.appName,
				status: compose.composeStatus,
				serverId: compose.serverId,
				serverName: compose.server?.name ?? null,
				icon: compose.icon ?? null,
				compose,
			};
		}
		if (!database) return database;
		return {
			...base,
			name: database.name,
			description: database.description ?? null,
			appName: database.appName,
			status: database.applicationStatus,
			serverId: database.serverId,
			serverName: database.server?.name ?? null,
			icon: null,
			database,
		};
	}, [ref, kind, id, application, compose, database]);
}

/** True until the first deploy starts: nothing runs yet, so there are no
    containers to read logs or stats from. A failed first deploy doesn't
    count, since its containers may be there, crashing. Undefined while the
    deploy state loads, so callers don't open a live session they then drop. */
export function useNotDeployed(): boolean | undefined {
	const { service, pending } = useService();
	if (!pending) return undefined;
	return pending.deployState === "never" && service.status === "idle";
}

export const databaseType = (kind: DatabaseKind) => kind as DatabaseType;

/** Where the service's code or image comes from, as a `SourceIcon` key: a
    Git provider, `git` for any other host, `docker`, `drop` or `raw`. */
export function sourceKind(service: ServiceInfo): string | null {
	const app = service.application;
	if (app) {
		return app.sourceType === "git"
			? sourceOfGitUrl(app.customGitUrl)
			: app.sourceType;
	}
	const compose = service.compose;
	if (compose) {
		if (compose.sourceType !== "git") return "raw";
		const git = compose.gitSource;
		return git?.type === "git" ? sourceOfGitUrl(git.url) : (git?.type ?? "git");
	}
	return null;
}

/** One status vocabulary everywhere (dot + word). */
export function statusOf(
	status: ServiceStatus | undefined,
	pending: PendingChanges | undefined,
): { label: string; tone: BadgeTone } {
	if (status === "running" || pending?.deployState === "deploying") {
		return { label: "Deploying", tone: "info" };
	}
	if (status === "error") return { label: "Failed", tone: "destructive" };
	if (status === "done") return { label: "Live", tone: "success" };
	if (pending?.deployState === "never") {
		return { label: "Not deployed", tone: "secondary" };
	}
	return { label: "Stopped", tone: "secondary" };
}
