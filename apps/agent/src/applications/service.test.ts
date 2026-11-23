import { describe, expect, it } from "vitest";
import type { Host } from "../host/types";
import { waitForScheduling } from "./service";

const hostWithTasks = (tasks: unknown[]) =>
	({ docker: () => ({ listTasks: async () => tasks }) }) as unknown as Host;

describe("waitForScheduling", () => {
	it("fails when Swarm rejects the new tasks", async () => {
		const host = hostWithTasks([
			{
				Spec: { ForceUpdate: 2 },
				DesiredState: "shutdown",
				Status: {
					State: "rejected",
					Err: "invalid mount config for type bind: bind source path does not exist: /opt/missing",
				},
			},
			{
				Spec: { ForceUpdate: 2 },
				DesiredState: "running",
				Status: { State: "new" },
			},
		]);
		await expect(waitForScheduling(host, "app", 2, 1_000)).rejects.toThrow(
			/rejected the new version: invalid mount config/,
		);
	});

	it("ignores rejected tasks of an older version", async () => {
		const host = hostWithTasks([
			{
				Spec: { ForceUpdate: 1 },
				DesiredState: "shutdown",
				Status: { State: "rejected", Err: "old" },
			},
			{
				Spec: { ForceUpdate: 2 },
				DesiredState: "running",
				Status: { State: "running" },
			},
		]);
		await expect(
			waitForScheduling(host, "app", 2, 1_000),
		).resolves.toBeUndefined();
	});

	it("reports tasks Swarm can't place", async () => {
		const host = hostWithTasks([
			{
				Spec: { ForceUpdate: 3 },
				DesiredState: "running",
				Status: {
					State: "pending",
					Err: "no suitable node (insufficient resources on 1 node)",
				},
			},
		]);
		await expect(waitForScheduling(host, "app", 3, 1_000)).rejects.toThrow(
			/could not start/,
		);
	});
});
