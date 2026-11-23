import { describe, expect, test } from "vitest";
import type { LiveConnection } from "./connection";
import { listServiceContainers } from "./containers";

describe("swarm serviceContainers listing", () => {
	test("a name that resolves only later is still checked before listing", async () => {
		let exists = false;
		const ran: string[] = [];
		const conn = {
			run: async (command: string) => {
				ran.push(command);
				if (command.startsWith("docker service inspect")) {
					return exists
						? { code: 0, stdout: "abc\n", stderr: "" }
						: { code: 1, stdout: "", stderr: "no such service" };
				}
				if (command.startsWith("docker inspect --type service")) {
					return {
						code: 0,
						stdout: `victim-abc123 ${JSON.stringify({ "panara-cloud.organization": "other-org", "panara-cloud.service.id": "s2" })}`,
						stderr: "",
					};
				}
				return {
					code: 0,
					stdout: '{"ID":"t1","Name":"victim-abc123.1"}\n',
					stderr: "",
				};
			},
		} as unknown as LiveConnection;
		const request = {
			kind: "serviceContainers",
			mode: "swarm",
			appName: "victim-abc123",
		} as unknown as Parameters<typeof listServiceContainers>[1];
		const restriction = { organizationId: "my-org", serviceId: "s1" };
		await expect(
			listServiceContainers(conn, request, restriction),
		).resolves.toEqual([]);
		exists = true;
		await expect(
			listServiceContainers(conn, request, restriction),
		).rejects.toThrow(/Not authorized/);
		expect(ran.some((c) => c.includes("service ps"))).toBe(false);
	});
});
