import { describe, expect, test } from "vitest";
import type { ExecOptions, Host } from "../host/types";
import { restoreVolume } from "./volumes";

const scriptOf = async (appName?: string) => {
	const inputs: string[] = [];
	const host = {
		kind: "local",
		exec: async (_command: string, options?: ExecOptions) => {
			inputs.push(options?.input ?? "");
			return { code: 0, output: "" };
		},
		run: async (_command: string, options?: ExecOptions) => {
			inputs.push(options?.input ?? "");
			return "";
		},
	} as unknown as Host;
	await restoreVolume(
		host,
		{
			volumeName: "redis-abc-data",
			appName,
			backupFile: "redis-abc/x/redis-abc-data-1.tar",
			destination: {
				accessKey: "a",
				secretAccessKey: "s",
				bucket: "b",
				region: "us-east-1",
				endpoint: "http://10.0.0.5:9000",
				additionalFlags: [],
			},
		},
		{ log: () => {} },
	);
	return inputs.join("\n");
};

describe("volume restore", () => {
	test("drops stopped Swarm task containers before checking who uses the volume", async () => {
		const script = await scriptOf();
		const stale = script.indexOf("label=com.docker.swarm.task.id");
		const inUse = script.indexOf("volume is in use");
		expect(stale).toBeGreaterThan(-1);
		expect(stale).toBeLessThan(inUse);
		const staleLine = script.split("\n").find((l) => l.includes("STALE=$("));
		expect(staleLine).toContain("--filter status=exited");
		expect(staleLine).not.toContain("status=running");
		expect(script).not.toContain("com.docker.compose.project");
	});

	test("also drops the owner's own stopped compose containers", async () => {
		const script = await scriptOf("keeper-abc");
		const loop = script.split("\n").find((l) => l.includes("for owner in"));
		expect(loop).toMatch(/com\.docker\.compose\.project\\?=keeper-abc/);
	});
});
