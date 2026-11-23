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

/** A service's custom icon (compose templates carry one), else its kind's.
    A custom icon is a picture with its own padding, so it is drawn larger
    than a glyph: `imageClassName` sizes it, `className` sizes the glyph. */
export function ServiceIcon({
	kind,
	icon,
	className,
	imageClassName = "size-5",
}: {
	kind: ServiceKind;
	icon?: string | null;
	className?: string;
	imageClassName?: string;
}) {
	if (icon) {
		return (
			<img
				src={icon}
				alt=""
				className={cn("shrink-0 rounded-sm object-contain", imageClassName)}
			/>
		);
	}
	const Icon = SERVICE_ICONS[kind];
	return <Icon className={cn("size-4 shrink-0", className)} />;
}
