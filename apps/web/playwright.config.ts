import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const envFile = path.resolve(import.meta.dirname, ".env.e2e.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
	testDir: "./tests/e2e",
	globalSetup: "./tests/e2e/global-setup.ts",
	fullyParallel: false,
	workers: 1,
	timeout: 120_000,
	expect: { timeout: 15_000 },
	reporter: [["list"]],
	outputDir: "test-results",
	use: {
		...devices["Desktop Chrome"],
		baseURL,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: {
		command: "pnpm dev",
		url: `${baseURL}/login`,
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
