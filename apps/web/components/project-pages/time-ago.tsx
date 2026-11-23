"use client";

import { format, formatDistanceToNowStrict } from "date-fns";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";

export function TimeAgo({
	time,
	fallback = "Never",
}: {
	time: number | null | undefined;
	fallback?: string;
}) {
	if (!time) return <span className="text-muted-foreground">{fallback}</span>;
	return (
		<Tooltip>
			<TooltipTrigger render={<span className="text-muted-foreground" />}>
				{formatDistanceToNowStrict(time, { addSuffix: true })}
			</TooltipTrigger>
			<TooltipContent>{format(time, "PPpp")}</TooltipContent>
		</Tooltip>
	);
}
