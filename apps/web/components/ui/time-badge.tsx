"use client";

import { api } from "@panara-cloud/backend/api";
import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export function TimeBadge({ className }: { className?: string }) {
	const serverTime = useQuery(api.platform.settings.serverTime);
	const [time, setTime] = useState<Date | null>(null);

	useEffect(() => {
		if (serverTime?.time) {
			setTime(new Date(serverTime.time));
		}
	}, [serverTime]);

	useEffect(() => {
		const timer = setInterval(() => {
			setTime((prevTime) => {
				if (!prevTime) return null;
				const newTime = new Date(prevTime.getTime() + 1000);
				return newTime;
			});
		}, 1000);

		return () => {
			clearInterval(timer);
		};
	}, []);

	if (!time || !serverTime?.timezone) {
		return null;
	}

	const getUtcOffset = (timeZone: string) => {
		const date = new Date();
		const utcDate = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
		const tzDate = new Date(date.toLocaleString("en-US", { timeZone }));
		const offset = (tzDate.getTime() - utcDate.getTime()) / (1000 * 60 * 60);
		const sign = offset >= 0 ? "+" : "-";
		const hours = Math.floor(Math.abs(offset));
		const minutes = (Math.abs(offset) * 60) % 60;
		return `UTC${sign}${hours.toString().padStart(2, "0")}:${minutes
			.toString()
			.padStart(2, "0")}`;
	};

	const formattedTime = new Intl.DateTimeFormat("en-US", {
		timeZone: serverTime.timezone,
		timeStyle: "medium",
		hour12: false,
	}).format(time);

	// A quiet line where times matter (cron schedules run on server time).
	return (
		<span
			className={cn(
				"inline-flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground",
				className,
			)}
			title={`${serverTime.timezone} | ${getUtcOffset(serverTime.timezone)}`}
		>
			<span>Server time</span>
			<span className="font-mono tabular-nums text-foreground">
				{formattedTime}
			</span>
			<span className="truncate font-mono">
				{getUtcOffset(serverTime.timezone)}
			</span>
		</span>
	);
}
