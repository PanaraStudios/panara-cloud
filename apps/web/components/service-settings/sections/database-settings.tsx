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
import { usePermissions } from "@/lib/permissions";
import { SettingsStack } from "../chrome";
import { ServiceDetailsForm } from "./details-form";
import type { SectionProps } from "./registry";

type IdProps = Record<string, string>;
const cast = (component: unknown) => component as ComponentType<IdProps>;

const CREDENTIALS: Record<
	DatabaseKind,
	{ Internal: ComponentType<IdProps>; External: ComponentType<IdProps> }
> = {
	postgres: {
		Internal: cast(ShowInternalPostgresCredentials),
		External: cast(ShowExternalPostgresCredentials),
	},
	mysql: {
		Internal: cast(ShowInternalMysqlCredentials),
		External: cast(ShowExternalMysqlCredentials),
	},
	mariadb: {
		Internal: cast(ShowInternalMariadbCredentials),
		External: cast(ShowExternalMariadbCredentials),
	},
	mongo: {
		Internal: cast(ShowInternalMongoCredentials),
		External: cast(ShowExternalMongoCredentials),
	},
	redis: {
		Internal: cast(ShowInternalRedisCredentials),
		External: cast(ShowExternalRedisCredentials),
	},
	libsql: {
		Internal: cast(ShowInternalLibsqlCredentials),
		External: cast(ShowExternalLibsqlCredentials),
	},
};

/** A database's General section: details, public access and credentials.
    Environment, volumes, resources, advanced and danger are their own
    sections in the settings list. */
export function DatabaseSettings(props: SectionProps) {
	const { kind, id } = props;
	const permissions = usePermissions();
	const database = kind as DatabaseKind;
	const { Internal, External } = CREDENTIALS[database];
	const idProps = { [`${database}Id`]: id };
	const canManage = permissions.service.create;
	return (
		<SettingsStack>
			<ServiceDetailsForm kind={kind} id={id} />
			{canManage ? <External {...idProps} /> : null}
			{canManage ? <Internal {...idProps} /> : null}
		</SettingsStack>
	);
}
