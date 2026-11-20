"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";

export type MountServiceType =
	| "application"
	| "compose"
	| "libsql"
	| "mariadb"
	| "mongo"
	| "mysql"
	| "postgres"
	| "redis";

export type MountInput = FunctionArgs<
	typeof api.applications.mounts.create
>["mount"];

// Mounts live in each service's own domain; this picks the right functions.
export function useServiceMounts(
	serviceId: string | undefined,
	serviceType: MountServiceType,
) {
	const application = useQuery(
		api.applications.mounts.list,
		serviceId && serviceType === "application"
			? { applicationId: serviceId as Id<"applications"> }
			: "skip",
	);
	const compose = useQuery(
		api.compose.mounts.list,
		serviceId && serviceType === "compose"
			? { composeId: serviceId as Id<"compose"> }
			: "skip",
	);
	const database = useQuery(
		api.databases.databases.mounts,
		serviceId && serviceType !== "application" && serviceType !== "compose"
			? { databaseId: serviceId as Id<"databases"> }
			: "skip",
	);
	return serviceType === "application"
		? application
		: serviceType === "compose"
			? compose
			: database;
}

export function useMountMutations(serviceType: MountServiceType) {
	const createApplication = useMutation(api.applications.mounts.create);
	const updateApplication = useMutation(api.applications.mounts.update);
	const removeApplication = useMutation(api.applications.mounts.remove);
	const createCompose = useMutation(api.compose.mounts.add);
	const updateCompose = useMutation(api.compose.mounts.update);
	const removeCompose = useMutation(api.compose.mounts.remove);
	const createDatabase = useMutation(api.databases.databases.addDatabaseMount);
	const updateDatabase = useMutation(
		api.databases.databases.updateDatabaseMount,
	);
	const removeDatabase = useMutation(
		api.databases.databases.removeDatabaseMount,
	);

	return {
		create: async (serviceId: string, mount: MountInput) => {
			if (serviceType === "application") {
				await createApplication({
					applicationId: serviceId as Id<"applications">,
					mount,
				});
			} else if (serviceType === "compose") {
				await createCompose({ composeId: serviceId as Id<"compose">, mount });
			} else {
				await createDatabase({
					databaseId: serviceId as Id<"databases">,
					mount,
				});
			}
		},
		update: async (mountId: string, mount: MountInput) => {
			const args = { mountId: mountId as Id<"mounts">, mount };
			if (serviceType === "application") await updateApplication(args);
			else if (serviceType === "compose") await updateCompose(args);
			else await updateDatabase(args);
		},
		remove: async (mountId: string) => {
			const args = { mountId: mountId as Id<"mounts"> };
			if (serviceType === "application") await removeApplication(args);
			else if (serviceType === "compose") await removeCompose(args);
			else await removeDatabase(args);
		},
	};
}
