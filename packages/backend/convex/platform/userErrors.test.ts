import { ConvexError } from "convex/values";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, setup } from "../test.setup";
import { parseSchedule } from "./lib/cron";
import {
	errorMessage,
	providerFetch,
	setHostResolverForTests,
} from "./lib/fetch";
import { validateChannel } from "./lib/notificationMessages";
import { assertSignalsSupported } from "./lib/telemetryAdapters";

afterEach(() => {
	setHostResolverForTests(async () => ["93.184.216.34"]);
	vi.unstubAllGlobals();
});

const thrownBy = async (run: () => unknown): Promise<unknown> => {
	try {
		await run();
	} catch (error) {
		return error;
	}
	return undefined;
};

// With REDACT_LOGS_TO_CLIENT only a ConvexError keeps its message on the way
// to the browser; a plain Error arrives as "Server Error".
describe("messages written for users are ConvexErrors", () => {
	test("validation in the provider libraries", async () => {
		for (const [run, message] of [
			[() => parseSchedule("every day at noon"), /Invalid cron expression/],
			[() => parseSchedule("0 0 * * *", "Mars/Olympus"), /Unknown timezone/],
			[
				() => validateChannel({ type: "custom", endpoint: "ftp://x" }),
				"Endpoint must be an http(s) URL",
			],
			[() => assertSignalsSupported("loki", []), "Select at least one signal"],
		] as const) {
			const error = await thrownBy(run);
			expect(error).toBeInstanceOf(ConvexError);
			expect((error as ConvexError<string>).data).toMatch(message);
		}
	});

	test("a refused host and an invalid URL", async () => {
		const blocked = await thrownBy(() => providerFetch("http://10.0.0.7/"));
		expect(blocked).toBeInstanceOf(ConvexError);
		expect((blocked as ConvexError<string>).data).toMatch(
			/private or internal network/,
		);
		const invalid = await thrownBy(() => providerFetch("not a url"));
		expect(invalid).toBeInstanceOf(ConvexError);
		expect((invalid as ConvexError<string>).data).toBe(
			"Invalid URL: not a url",
		);
	});

	test("a failed connection names the host and the reason, never the request URL", async () => {
		const url = "https://api.example.com/bot123:SECRET/sendMessage";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError(
					`error sending request for url (${url}): client error (Connect): tcp connect error: Connection refused (os error 111)`,
				);
			}),
		);
		const convexRuntime = await thrownBy(() => providerFetch(url));
		expect(convexRuntime).toBeInstanceOf(ConvexError);
		expect((convexRuntime as ConvexError<string>).data).toBe(
			"Could not connect to api.example.com: client error (Connect): tcp connect error: Connection refused (os error 111)",
		);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed", {
					cause: new Error("connect ECONNREFUSED 203.0.113.9:443"),
				});
			}),
		);
		const nodeRuntime = await thrownBy(() => providerFetch(url));
		expect((nodeRuntime as ConvexError<string>).data).toBe(
			"Could not connect to api.example.com: connect ECONNREFUSED 203.0.113.9:443",
		);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new DOMException("The operation timed out.", "TimeoutError");
			}),
		);
		const timedOut = await thrownBy(() => providerFetch(url));
		expect((timedOut as ConvexError<string>).data).toBe(
			"Could not connect to api.example.com: the request timed out",
		);
	});

	test("a notification test reports the failure without the webhook URL", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				throw new TypeError(
					`error sending request for url (${input}): client error (Connect): dns error`,
				);
			}),
		);
		const error = await thrownBy(() =>
			asUser(t, "alice").action(api.platform.notifications.test, {
				organizationId: "org1",
				channel: {
					type: "custom",
					endpoint: "https://hooks.example.com/T0PSECRET",
				},
				credentials: {},
			}),
		);
		expect(error).toBeInstanceOf(ConvexError);
		expect((error as ConvexError<string>).data).toBe(
			"Error testing the notification: Could not connect to hooks.example.com: client error (Connect): dns error",
		);
	});
});

describe("errorMessage", () => {
	test("reads a ConvexError's own text, also after it crossed a function call", () => {
		const nested = new ConvexError("Failed to send email: connection refused");
		nested.message =
			"Uncaught ConvexError: Failed to send email: connection refused\n    at handler (../../convex/platform/notificationsNode.ts:39:4)\n";
		expect(errorMessage(nested)).toBe(
			"Failed to send email: connection refused",
		);
	});

	test("drops the stack frames of a plain error from a nested call", () => {
		expect(
			errorMessage(
				new Error(
					"Uncaught TypeError: boom\n    at handler (../../convex/x.ts:1:1)\n",
				),
			),
		).toBe("boom");
		expect(errorMessage(new Error("plain"))).toBe("plain");
		expect(errorMessage("text")).toBe("text");
	});
});
