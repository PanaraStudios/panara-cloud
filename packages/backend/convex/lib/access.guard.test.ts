/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";

// Organization scoping of API keys holds because every function learns who
// is calling from lib/access.ts. These checks keep it that way: code that
// reads the identity itself would not know about API keys.

const sources = import.meta.glob(
	["../**/*.ts", "!../**/*.test.ts", "!../_generated/**", "!../betterAuth/**"],
	{ query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const filesUsing = (pattern: RegExp, allowed: string[]) =>
	Object.entries(sources)
		.filter(([path, source]) => pattern.test(source) && !allowed.includes(path))
		.map(([path]) => path);

describe("identity is read in one place", () => {
	test("only the access helpers call getUserIdentity", () => {
		expect(
			filesUsing(/getUserIdentity\s*\(/, [
				"./access.ts",
				"./agentAuth.ts",
				// Reads the session id of a browser session it has already
				// established through sessionUser().
				"../account.ts",
			]),
		).toEqual([]);
	});

	test("only sessionUser reads the Better Auth user", () => {
		expect(
			filesUsing(/safeGetAuthUser|\bgetAuthUser\s*\(/, ["../auth.ts"]),
		).toEqual([]);
	});

	test("the caller's instance administrator flag is read through isInstanceAdministrator", () => {
		// The remaining readers look up a user other than the caller, or run
		// only for a browser session.
		expect(
			filesUsing(/policy\.isInstanceAdmin\b/, [
				"../infra/access.ts",
				"../users.ts",
				"../auth.ts",
				"../account.ts",
				"../platform/onboarding.ts",
			]),
		).toEqual([]);
	});
});
