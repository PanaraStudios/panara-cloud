"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useQuery } from "convex/react";
import { useMemo } from "react";

export type DatabaseType =
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis"
	| "libsql";

export const databaseId = (id: string) => id as Id<"databases">;

// One `databases` row in the flat shape the database screens read:
// `applicationStatus`, `databasePassword`, ...
// Memoized on the query result: screens reset their forms when it changes.
export const useDatabase = (id: string | undefined) => {
	const data = useQuery(
		api.databases.databases.one,
		id ? { databaseId: databaseId(id) } : "skip",
	);
	return useMemo(
		() =>
			data
				? {
						...data,
						databaseId: data._id,
						postgresId: data._id,
						mysqlId: data._id,
						mariadbId: data._id,
						mongoId: data._id,
						redisId: data._id,
						libsqlId: data._id,
						applicationStatus: data.status,
						databasePassword: data.password ?? undefined,
						databaseRootPassword: data.rootPassword ?? undefined,
						serverId: data.serverId ?? null,
					}
				: data,
		[data],
	);
};

export type DatabaseData = NonNullable<ReturnType<typeof useDatabase>>;
