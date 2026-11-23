import { ConvexError } from "convex/values";

// Convex's own words when a mutation kept losing to other writes of what it
// had read, after its retries.
const WRITE_CONFLICT =
	/changed while this mutation was being run|OptimisticConcurrencyControlFailure/;

/** A mutation that failed only because others wrote at the same moment. */
export const isWriteConflict = (error: unknown): boolean =>
	!(error instanceof ConvexError) &&
	WRITE_CONFLICT.test(error instanceof Error ? error.message : String(error));

type RetryOptions = {
	/** How many times `run` is tried in all. */
	attempts?: number;
	wait?: (ms: number) => Promise<void>;
	random?: () => number;
};

/**
 * Runs a mutation from an action and tries it again when it lost to other
 * writes: several callers that collided start again a random moment apart,
 * so they stop colliding. Anything else it throws is thrown at once.
 */
export async function retryWriteConflicts<T>(
	run: () => Promise<T>,
	{
		attempts = 5,
		wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		random = Math.random,
	}: RetryOptions = {},
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await run();
		} catch (error) {
			if (attempt >= attempts || !isWriteConflict(error)) throw error;
			await wait(Math.round((50 + random() * 250) * attempt));
		}
	}
}
