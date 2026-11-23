import type Dockerode from "dockerode";
import { describe, expect, test } from "vitest";
import { upsertApplicationService } from "../applications/service";
import type { Host } from "../host/types";
import { inSequence, upsertService } from "./swarm";

const OUT_OF_SEQUENCE =
	"(HTTP code 500) server error - rpc error: code = Unknown desc = update out of sequence";

// A Swarm whose service moves to a new version by itself `moves` times (it
// is finishing the update before), refusing an update made for the old one.
const fakeSwarm = (moves: number) => {
	let version = 10;
	let pending = moves;
	const updates: { version: number; ForceUpdate?: number }[] = [];
	let inspects = 0;
	const docker = {
		getService: () => ({
			inspect: async () => {
				inspects++;
				return {
					Version: { Index: String(version) },
					Spec: { Labels: { kept: "yes" }, TaskTemplate: { ForceUpdate: 3 } },
				};
			},
			update: async (options: {
				version: number;
				TaskTemplate?: { ForceUpdate?: number };
			}) => {
				if (pending > 0) {
					pending--;
					version++;
					throw new Error(OUT_OF_SEQUENCE);
				}
				updates.push({
					version: options.version,
					ForceUpdate: options.TaskTemplate?.ForceUpdate,
				});
				version++;
			},
		}),
	};
	return {
		docker: docker as unknown as Dockerode,
		updates,
		inspects: () => inspects,
	};
};

const settings = { Name: "app-test", TaskTemplate: {} };
const fast = { pauseMs: 1 };

describe("an update Swarm refuses as out of sequence", () => {
	test("is repeated with the service read again", async () => {
		const swarm = fakeSwarm(2);
		await expect(upsertService(swarm.docker, settings)).resolves.toBe(
			"updated",
		);
		// The update that went through carries the version of its own read.
		expect(swarm.updates).toEqual([{ version: 12, ForceUpdate: 4 }]);
		expect(swarm.inspects()).toBe(3);
	});

	test("the same for an application's service, which keeps its count of forced updates", async () => {
		const swarm = fakeSwarm(1);
		const host = { docker: () => swarm.docker } as unknown as Host;
		await expect(upsertApplicationService(host, settings)).resolves.toEqual({
			action: "updated",
			forceUpdate: 4,
		});
		expect(swarm.updates).toEqual([{ version: 11, ForceUpdate: 4 }]);
	});

	test("gives up after a few tries with Swarm's own words", async () => {
		let tries = 0;
		await expect(
			inSequence(
				async () => {
					tries++;
					throw new Error(OUT_OF_SEQUENCE);
				},
				{ retries: 3, ...fast },
			),
		).rejects.toThrow("update out of sequence");
		expect(tries).toBe(4);
	});

	test("any other failure is not repeated", async () => {
		let tries = 0;
		await expect(
			inSequence(async () => {
				tries++;
				throw new Error("no such image: nginx:nope");
			}, fast),
		).rejects.toThrow("no such image");
		expect(tries).toBe(1);
	});
});
