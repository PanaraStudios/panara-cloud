import { describe, expect, test } from "vitest";
import type { Host } from "../host/types";
import { parseAddresses, probeHostAddresses } from "./addresses";

describe("server address probe", () => {
	test("keeps interface and public addresses, once each", () => {
		expect(
			parseAddresses(
				"10.0.0.5\n172.18.0.1\n2a01:4f8::1\n203.0.113.7\n203.0.113.7\n",
			),
		).toEqual(["10.0.0.5", "172.18.0.1", "2a01:4f8::1", "203.0.113.7"]);
	});

	test("ignores noise such as curl errors", () => {
		expect(
			parseAddresses("curl: (6) Could not resolve host\n198.51.100.2"),
		).toEqual(["198.51.100.2"]);
		expect(parseAddresses("")).toEqual([]);
	});

	test("runs the probe on the host", async () => {
		const host = {
			exec: async (command: string) => ({
				code: 0,
				output: command.includes("ip -o addr") ? "192.0.2.10\n" : "",
			}),
		} as unknown as Host;
		await expect(probeHostAddresses(host)).resolves.toEqual(["192.0.2.10"]);
	});
});
