export type TimeFilter = "all" | "1h" | "6h" | "24h" | "168h" | "720h";

export const SINCE_OPTIONS: Array<{ label: string; value: TimeFilter }> = [
	{ label: "All time", value: "all" },
	{ label: "Last hour", value: "1h" },
	{ label: "Last 6 hours", value: "6h" },
	{ label: "Last 24 hours", value: "24h" },
	{ label: "Last 7 days", value: "168h" },
	{ label: "Last 30 days", value: "720h" },
];
