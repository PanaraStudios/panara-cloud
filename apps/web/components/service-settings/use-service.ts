"use client";

import { useApplication } from "@/components/dashboard/application/use-application";
import { useCompose } from "@/components/dashboard/compose/use-compose";
import { useDatabase } from "@/components/dashboard/database/use-database";
import { isDatabaseKind, type ServiceKind } from "@/lib/navigation";

export type ServiceBasics = {
	name: string;
	description: string;
	appName: string;
	serverId: string | null;
	sourceType: string | null;
	icon: string | null;
};

/** The fields every settings section needs, whatever the kind. Undefined
    while loading, null when the service is gone. */
export function useServiceBasics(
	kind: ServiceKind,
	id: string,
): ServiceBasics | null | undefined {
	const application = useApplication(kind === "application" ? id : undefined);
	const compose = useCompose(kind === "compose" ? id : undefined);
	const database = useDatabase(isDatabaseKind(kind) ? id : undefined);
	if (kind === "application") {
		if (!application) return application;
		return {
			name: application.name,
			description: application.description ?? "",
			appName: application.appName,
			serverId: application.serverId ?? null,
			sourceType: application.sourceType,
			icon: application.icon ?? null,
		};
	}
	if (kind === "compose") {
		if (!compose) return compose;
		return {
			name: compose.name,
			description: compose.description ?? "",
			appName: compose.appName,
			serverId: compose.serverId,
			sourceType: compose.sourceType ?? null,
			icon: compose.icon ?? null,
		};
	}
	if (!database) return database;
	return {
		name: database.name,
		description: database.description ?? "",
		appName: database.appName,
		serverId: database.serverId,
		sourceType: null,
		icon: null,
	};
}
