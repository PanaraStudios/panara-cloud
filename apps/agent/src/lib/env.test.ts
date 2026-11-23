import { describe, expect, test } from "vitest";
import {
	envForFile,
	envObject,
	parseEnv,
	prepareEnvironmentVariables,
} from "./env";

describe("environment variables", () => {
	test("parses dotenv text with comments, quotes and export", () => {
		expect(
			parseEnv("# c\nexport A=1\nB=\"two words\"\nC='x=y'\nD=val # note\n\nE="),
		).toEqual({ A: "1", B: "two words", C: "x=y", D: "val", E: "" });
	});

	test("resolves project, environment and self references", () => {
		const pairs = prepareEnvironmentVariables(
			"DB=${{project.DB_URL}}\nREGION=${{environment.REGION}}\nPORT=3000\nURL=http://x:${{PORT}}",
			"DB_URL=postgres://db",
			"REGION=eu",
		);
		expect(envObject(pairs)).toEqual({
			DB: "postgres://db",
			REGION: "eu",
			PORT: "3000",
			URL: "http://x:3000",
		});
	});

	test("rejects unknown references", () => {
		expect(() => prepareEnvironmentVariables("A=${{project.MISSING}}")).toThrow(
			/project.MISSING/,
		);
	});

	test("escapes values for compose .env files", () => {
		expect(envForFile(['A=say "hi" $HOME ${KEEP}'])).toEqual([
			'A="say \\"hi\\" \\$HOME ${KEEP}"',
		]);
	});
});
