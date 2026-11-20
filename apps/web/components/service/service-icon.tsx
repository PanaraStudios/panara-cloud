import { CircuitBoard, GlobeIcon } from "lucide-react";
import type { ComponentType } from "react";
import {
	LibsqlIcon,
	MariadbIcon,
	MongodbIcon,
	MysqlIcon,
	PostgresqlIcon,
	RedisIcon,
} from "@/components/icons/data-tools-icons";
import type { ServiceKind } from "@/lib/navigation";
import { cn } from "@/lib/utils";

export const SERVICE_ICONS: Record<
	ServiceKind,
	ComponentType<{ className?: string }>
> = {
	application: GlobeIcon,
	compose: CircuitBoard,
	postgres: PostgresqlIcon,
	mysql: MysqlIcon,
	mariadb: MariadbIcon,
	mongo: MongodbIcon,
	redis: RedisIcon,
	libsql: LibsqlIcon,
};

/** A service's custom icon (compose templates carry one), else its kind's. */
export function ServiceIcon({
	kind,
	icon,
	className,
}: {
	kind: ServiceKind;
	icon?: string | null;
	className?: string;
}) {
	if (icon) {
		return (
			<img
				src={icon}
				alt=""
				className={cn("size-4 shrink-0 object-contain", className)}
			/>
		);
	}
	const Icon = SERVICE_ICONS[kind];
	return <Icon className={cn("size-4 shrink-0", className)} />;
}
