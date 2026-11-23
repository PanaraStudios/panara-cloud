"use client";

export const badgeStateColor = (state: string) => {
	switch (state) {
		case "running":
		case "ready":
			return "success";
		case "exited":
		case "shutdown":
			return "destructive";
		case "accepted":
		case "created":
			return "info";
		default:
			return "default";
	}
};
