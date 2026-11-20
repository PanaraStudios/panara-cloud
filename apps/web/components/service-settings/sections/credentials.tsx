"use client";

import type { ComponentType } from "react";
import { ShowExternalLibsqlCredentials } from "@/components/dashboard/libsql/general/show-external-libsql-credentials";
import { ShowInternalLibsqlCredentials } from "@/components/dashboard/libsql/general/show-internal-libsql-credentials";
import { ShowExternalMariadbCredentials } from "@/components/dashboard/mariadb/general/show-external-mariadb-credentials";
import { ShowInternalMariadbCredentials } from "@/components/dashboard/mariadb/general/show-internal-mariadb-credentials";
import { ShowExternalMongoCredentials } from "@/components/dashboard/mongo/general/show-external-mongo-credentials";
import { ShowInternalMongoCredentials } from "@/components/dashboard/mongo/general/show-internal-mongo-credentials";
import { ShowExternalMysqlCredentials } from "@/components/dashboard/mysql/general/show-external-mysql-credentials";
import { ShowInternalMysqlCredentials } from "@/components/dashboard/mysql/general/show-internal-mysql-credentials";
import { ShowExternalPostgresCredentials } from "@/components/dashboard/postgres/general/show-external-postgres-credentials";
import { ShowInternalPostgresCredentials } from "@/components/dashboard/postgres/general/show-internal-postgres-credentials";
import { ShowExternalRedisCredentials } from "@/components/dashboard/redis/general/show-external-redis-credentials";
import { ShowInternalRedisCredentials } from "@/components/dashboard/redis/general/show-internal-redis-credentials";
import type { DatabaseKind } from "@/lib/navigation";

type IdProps = Record<string, string>;

const ENGINES: Record<
	DatabaseKind,
	{ Internal: ComponentType<IdProps>; External: ComponentType<IdProps> }
> = {
	postgres: {
		Internal:
			ShowInternalPostgresCredentials as unknown as ComponentType<IdProps>,
		External:
			ShowExternalPostgresCredentials as unknown as ComponentType<IdProps>,
	},
	mysql: {
		Internal: ShowInternalMysqlCredentials as unknown as ComponentType<IdProps>,
		External: ShowExternalMysqlCredentials as unknown as ComponentType<IdProps>,
	},
	mariadb: {
		Internal:
			ShowInternalMariadbCredentials as unknown as ComponentType<IdProps>,
		External:
			ShowExternalMariadbCredentials as unknown as ComponentType<IdProps>,
	},
	mongo: {
		Internal: ShowInternalMongoCredentials as unknown as ComponentType<IdProps>,
		External: ShowExternalMongoCredentials as unknown as ComponentType<IdProps>,
	},
	redis: {
		Internal: ShowInternalRedisCredentials as unknown as ComponentType<IdProps>,
		External: ShowExternalRedisCredentials as unknown as ComponentType<IdProps>,
	},
	libsql: {
		Internal:
			ShowInternalLibsqlCredentials as unknown as ComponentType<IdProps>,
		External:
			ShowExternalLibsqlCredentials as unknown as ComponentType<IdProps>,
	},
};

/** Connection details: internal credentials and the external port. */
export function DatabaseCredentials({
	kind,
	id,
}: {
	kind: DatabaseKind;
	id: string;
}) {
	const { Internal, External } = ENGINES[kind];
	const props = { [`${kind}Id`]: id };
	return (
		<>
			<Internal {...props} />
			<External {...props} />
		</>
	);
}
