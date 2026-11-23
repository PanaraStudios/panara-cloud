import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Many of these tests run real shells (install.sh, the firewall script,
		// LocalHost): work that takes a multiple of its quiet-machine time when
		// the machine is busy, as beside a build or a second suite. None of them
		// waits on a timer, so the limit is only there to end a hang; vitest's
		// default of 5 s failed one test or another about once in ten such runs.
		testTimeout: 30_000,
	},
});
