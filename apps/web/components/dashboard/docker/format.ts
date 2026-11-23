import type { Id } from "@panara-cloud/backend/dataModel";

// Docker CLI style sizes (decimal units), as `docker images` prints them.
export const formatDockerSize = (bytes: number | null | undefined) => {
	if (bytes === null || bytes === undefined || bytes < 0) return "N/A";
	const units = ["B", "kB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit++;
	}
	const digits = unit === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
	return `${value.toFixed(digits).replace(/\.0+$/, "")}${units[unit]}`;
};

// "3 days ago", like docker's CreatedSince.
export const timeSince = (date: Date) => {
	const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
	const steps: [number, string][] = [
		[60 * 60 * 24 * 365, "year"],
		[60 * 60 * 24 * 30, "month"],
		[60 * 60 * 24 * 7, "week"],
		[60 * 60 * 24, "day"],
		[60 * 60, "hour"],
		[60, "minute"],
	];
	for (const [size, name] of steps) {
		const count = Math.floor(seconds / size);
		if (count >= 1) return `${count} ${name}${count === 1 ? "" : "s"} ago`;
	}
	return "Less than a minute ago";
};

export const toServerId = (serverId: string | null | undefined) =>
	(serverId || undefined) as Id<"servers"> | undefined;
