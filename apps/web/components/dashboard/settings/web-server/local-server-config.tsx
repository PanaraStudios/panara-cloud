"use client";

import { z } from "zod";

const Schema = z.object({
	port: z.number().min(1, "Port must be higher than 0"),
	username: z.string().min(1, "Username is required"),
});

type Schema = z.infer<typeof Schema>;

const DEFAULT_LOCAL_SERVER_DATA: Schema = {
	port: 22,
	username: "root",
};

/** Returns local server data for use with local server terminal */
export const getLocalServerData = () => {
	try {
		const localServerData = localStorage.getItem("localServerData");
		const parsedLocalServerData = localServerData
			? (JSON.parse(localServerData) as typeof DEFAULT_LOCAL_SERVER_DATA)
			: DEFAULT_LOCAL_SERVER_DATA;

		return parsedLocalServerData;
	} catch {
		return DEFAULT_LOCAL_SERVER_DATA;
	}
};

export const saveLocalServerData = (data: Schema) => {
	localStorage.setItem("localServerData", JSON.stringify(data));
};
