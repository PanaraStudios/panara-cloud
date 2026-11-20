"use client";

import { api } from "@panara-cloud/backend/api";
import type { Doc, Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useApplication } from "../use-application";

export type ServiceType =
	| "application"
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis"
	| "libsql";

type SettingsDoc = Doc<"applications"> | Doc<"databases">;

const SETTING_KEYS = [
	"healthCheckSwarm",
	"restartPolicySwarm",
	"placementSwarm",
	"updateConfigSwarm",
	"rollbackConfigSwarm",
	"modeSwarm",
	"labelsSwarm",
	"networkSwarm",
	"stopGracePeriodSwarm",
	"endpointSpecSwarm",
	"ulimitsSwarm",
	"memoryLimit",
	"memoryReservation",
	"cpuLimit",
	"cpuReservation",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

// `null` clears a setting; an omitted key leaves it unchanged.
export type SettingsPatch = {
	[K in SettingKey]?: SettingsDoc[K] | null;
};

// The swarm/resource settings of an application or database and a single
// `update(patch)` for the forms that edit them.
export function useServiceSettings(id: string, type: ServiceType) {
	const isApplication = type === "application";
	const application = useApplication(isApplication ? id : undefined);
	const database = useQuery(
		api.databases.databases.get,
		!isApplication && id ? { databaseId: id as Id<"databases"> } : "skip",
	);
	const updateApplication = useMutation(
		api.applications.settings.updateServiceSettings,
	);
	const updateDatabase = useMutation(
		api.databases.databases.updateServiceSettings,
	);

	const data = isApplication ? application : database;

	const update = async (patch: SettingsPatch) => {
		const set: Record<string, unknown> = {};
		const clear: SettingKey[] = [];
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) continue;
			if (value === null) clear.push(key as SettingKey);
			else set[key] = value;
		}
		if (isApplication) {
			await updateApplication({
				applicationId: id as Id<"applications">,
				clear,
				...set,
			});
			return;
		}
		if (!database) throw new Error("Database not loaded");
		// The databases mutation replaces every setting at once.
		const current: Record<string, unknown> = {};
		for (const key of SETTING_KEYS) {
			if (database[key] !== undefined && !clear.includes(key)) {
				current[key] = database[key];
			}
		}
		await updateDatabase({
			databaseId: id as Id<"databases">,
			...current,
			...set,
		});
	};

	return { data, update };
}
