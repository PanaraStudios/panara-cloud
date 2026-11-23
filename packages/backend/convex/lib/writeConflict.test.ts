import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { isWriteConflict, retryWriteConflicts } from "./writeConflict";

// What Convex throws from runMutation when the retries of a mutation all lost.
const conflict = () =>
	new Error(
		'Documents read from or written to the "liveSessions" table changed while this mutation was being run and on every subsequent retry. A call to "live/agent.js:redeem" changed the document with ID "t175s1cd5s7kjy".',
	);

const quiet = { wait: async () => {}, random: () => 0.5 };

describe("write conflicts", () => {
	test("are told from every other failure", () => {
		expect(isWriteConflict(conflict())).toBe(true);
		expect(
			isWriteConflict(new Error("OptimisticConcurrencyControlFailure")),
		).toBe(true);
		expect(isWriteConflict(new Error("Server Error"))).toBe(false);
		expect(isWriteConflict("nope")).toBe(false);
		// A refusal of ours is never a conflict, whatever it says.
		expect(
			isWriteConflict(
				new ConvexError("changed while this mutation was being run"),
			),
		).toBe(false);
	});

	test("the mutation is run again until it gets through", async () => {
		let calls = 0;
		const waits: number[] = [];
		const result = await retryWriteConflicts(
			async () => {
				calls++;
				if (calls < 3) throw conflict();
				return "session";
			},
			{ wait: async (ms) => void waits.push(ms), random: () => 0.5 },
		);
		expect(result).toBe("session");
		expect(calls).toBe(3);
		// A longer wait each time, and never none.
		expect(waits).toEqual([175, 350]);
	});

	test("callers that collided wait different times", async () => {
		const waits: number[] = [];
		const randoms = [0, 0.999];
		for (const value of randoms) {
			let calls = 0;
			await retryWriteConflicts(
				async () => {
					if (calls++ === 0) throw conflict();
				},
				{ wait: async (ms) => void waits.push(ms), random: () => value },
			);
		}
		expect(waits[0]).toBe(50);
		expect(waits[1]).toBeGreaterThan(250);
	});

	test("a refusal is thrown at once", async () => {
		let calls = 0;
		await expect(
			retryWriteConflicts(async () => {
				calls++;
				throw new ConvexError("Too many open live sessions; close some first");
			}, quiet),
		).rejects.toThrow("Too many open live sessions");
		expect(calls).toBe(1);
	});

	test("it gives up after the last try with the conflict itself", async () => {
		let calls = 0;
		await expect(
			retryWriteConflicts(
				async () => {
					calls++;
					throw conflict();
				},
				{ ...quiet, attempts: 4 },
			),
		).rejects.toThrow("changed while this mutation was being run");
		expect(calls).toBe(4);
	});
});
