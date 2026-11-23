import { describe, expect, test } from "vitest";
import type { ExecOptions, ExecResult, Host } from "../host/types";
import { afterServiceUpdate } from "./deploy";
import { type BuildLog, CancelledError, runScript } from "./process";

const collect = () => {
	const lines: string[] = [];
	const log: BuildLog = {
		line: (text) => lines.push(text),
		append: (text) => lines.push(text),
	};
	return { lines, log };
};

// A host whose launcher ends as `launch` says; the kill a cancel sends is
// recorded and answers at once.
const fakeHost = (launch: (options?: ExecOptions) => Promise<ExecResult>) => {
	const commands: string[] = [];
	const host = {
		exec: async (command: string, options?: ExecOptions) => {
			commands.push(command);
			if (command.includes("kill -TERM")) return { code: 0, output: "" };
			return launch(options);
		},
	} as unknown as Host;
	return { host, commands };
};

describe("a cancellable script", () => {
	test("that ran to its end is done, also when a cancel came while it finished", async () => {
		const controller = new AbortController();
		const { log } = collect();
		const { host, commands } = fakeHost(async () => {
			// The cancel lands when the last command has already run.
			controller.abort();
			return { code: 0, output: "Docker Compose Deployed: ✅\n" };
		});
		await expect(
			runScript(host, "docker compose up -d", {
				log,
				signal: controller.signal,
			}),
		).resolves.toBe("Docker Compose Deployed: ✅\n");
		// The kill was still sent: nothing of the script is left running.
		expect(commands.some((command) => command.includes("kill -TERM"))).toBe(
			true,
		);
	});

	test("that the cancel killed is cancelled", async () => {
		const controller = new AbortController();
		const { log } = collect();
		const { host } = fakeHost(async () => {
			controller.abort();
			return { code: 143, output: "Terminated\n" };
		});
		await expect(
			runScript(host, "sleep 600", { log, signal: controller.signal }),
		).rejects.toBeInstanceOf(CancelledError);
	});

	test("is not started once a cancel is known", async () => {
		const controller = new AbortController();
		controller.abort();
		const { log } = collect();
		const { host, commands } = fakeHost(async () => ({ code: 0, output: "" }));
		await expect(
			runScript(host, "true", { log, signal: controller.signal }),
		).rejects.toBeInstanceOf(CancelledError);
		expect(commands).toEqual([]);
	});

	test("that failed by itself says how", async () => {
		const { log } = collect();
		const { host } = fakeHost(async () => ({
			code: 1,
			output: "step 1\nstep 2\nno such image\n",
		}));
		await expect(runScript(host, "false", { log })).rejects.toThrow(
			"step 1\nstep 2\nno such image",
		);
	});
});

describe("what is left of a deploy after the service update", () => {
	test("a cancel there stops the rest and leaves the deployment standing", async () => {
		const controller = new AbortController();
		const { lines, log } = collect();
		await expect(
			afterServiceUpdate(
				async () => {
					controller.abort();
					throw new CancelledError();
				},
				log,
				controller.signal,
			),
		).resolves.toBeUndefined();
		expect(lines).toEqual([
			"Cancel arrived after the service was updated: the deployment stands; its rollback image was not saved.",
		]);
	});

	test("a failure that is not a cancel still fails the deploy", async () => {
		const { lines, log } = collect();
		const controller = new AbortController();
		await expect(
			afterServiceUpdate(
				async () => {
					throw new Error("registry unreachable");
				},
				log,
				controller.signal,
			),
		).rejects.toThrow("registry unreachable");
		expect(lines).toEqual([]);
	});

	test("nothing is said when it just finishes", async () => {
		const { lines, log } = collect();
		await afterServiceUpdate(async () => {}, log);
		expect(lines).toEqual([]);
	});
});
