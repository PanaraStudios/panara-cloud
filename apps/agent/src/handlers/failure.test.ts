import { describe, expect, test } from "vitest";
import { FailedAfterHandoff } from "../lib/handoff";
import { fail } from "./databases/common";
import { failureReport, type JobContext, JobFailure } from "./types";

const contextWith = (aborted: boolean) => {
	const controller = new AbortController();
	if (aborted) controller.abort();
	const lines: string[] = [];
	const ctx = {
		signal: controller.signal,
		log: { line: (text: string) => lines.push(text) },
	} as unknown as JobContext;
	return { ctx, lines };
};

const thrown = (run: () => unknown) => {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("did not throw");
};

describe("how a job that threw is reported", () => {
	test("a cancel that took effect reads Cancelled", () => {
		const { ctx, lines } = contextWith(true);
		const error = thrown(() => fail(ctx, new Error("signal aborted")));
		expect(error).toMatchObject({ message: "Cancelled", despiteCancel: false });
		expect(lines).toEqual(["❌ Cancelled"]);
		expect(failureReport(error, true)).toEqual({ error: "Cancelled" });
		expect(failureReport(new Error("ssh closed"), true)).toEqual({
			error: "Cancelled",
		});
	});

	test("work Docker already had that failed is a failure, cancel or not", () => {
		const { ctx, lines } = contextWith(true);
		const error = thrown(() =>
			fail(ctx, new FailedAfterHandoff("did not converge")),
		);
		expect(error).toBeInstanceOf(JobFailure);
		expect(error).toMatchObject({
			message: "did not converge",
			despiteCancel: true,
		});
		expect(lines).toEqual(["❌ did not converge"]);
		expect(failureReport(error, true)).toEqual({
			error: "did not converge",
			despiteCancel: true,
		});
	});

	test("without a cancel, a failure says what went wrong", () => {
		expect(failureReport(new Error("no such image"), false)).toEqual({
			error: "no such image",
		});
	});
});
