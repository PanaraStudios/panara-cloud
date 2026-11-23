import { describe, expect, test } from "vitest";
import { CancelledError } from "../applications/process";
import type { ExecOptions, ExecResult, Host } from "../host/types";
import { FailedAfterHandoff } from "../lib/handoff";
import {
	type ComposeVersion,
	composePlan,
	deployCommand,
	parseComposeVersion,
} from "./command";
import {
	type ComposeJobInput,
	deployScripts,
	layoutOf,
	preparationArgs,
	runDeployScripts,
} from "./host";

const composeInput = (
	compose: Partial<ComposeJobInput["compose"]> = {},
	trusted = true,
): ComposeJobInput => ({
	compose: {
		id: "c1",
		organizationId: "org1",
		projectId: "p1",
		environmentId: "e1",
		name: "Shop",
		appName: "shop-abc123",
		composeType: "docker-compose",
		sourceType: "raw",
		composePath: "docker-compose.yml",
		command: "",
		createEnvFile: true,
		randomize: false,
		suffix: "",
		isolatedDeployment: false,
		isolatedDeploymentsVolume: false,
		pullImages: false,
		...compose,
	},
	composeFile: null,
	env: "",
	projectEnv: "",
	environmentEnv: "",
	domains: [],
	mounts: [],
	serviceNetworks: [],
	trusted,
});

const CURRENT: ComposeVersion = [2, 40, 3];

const scriptsFor = (
	input: ComposeJobInput,
	freshVolumes = false,
	version: ComposeVersion | null = CURRENT,
) => {
	const layout = layoutOf(input);
	return deployScripts(input, layout, {
		preparation: preparationArgs(
			input,
			layout,
			composePlan(input.compose.pullImages, version),
		),
		args: "UP",
		freshVolumes,
	});
};

describe("what a compose deploy runs before and after it hands the project to docker", () => {
	test("pulls and builds come first; nothing touches a container until `up`", () => {
		const { prepare, apply } = scriptsFor(
			composeInput({ isolatedDeployment: true }),
			true,
		);
		expect(prepare).toContain(
			"compose -p shop-abc123 --env-file .env -f docker-compose.yml pull --ignore-pull-failures --policy missing 2>&1 || true",
		);
		expect(prepare).toContain(
			'compose -p shop-abc123 --env-file .env -f docker-compose.yml build 2>&1 || { echo "Error: ❌ Docker command failed"; exit 1; }',
		);
		expect(prepare.indexOf(" pull ")).toBeLessThan(prepare.indexOf(" build "));
		for (const touches of [" up", "down --volumes", "network"]) {
			expect(prepare).not.toContain(touches);
		}
		expect(apply).toContain("down --volumes");
		expect(apply).toContain("$DOCKER UP 2>&1");
		expect(apply).toContain("network connect");
		expect(apply).not.toContain(" build");
		expect(apply).not.toContain(" pull");
	});

	test("with pull images, everything that isn't built is pulled first, and a failed pull stops the deploy", () => {
		const { prepare } = scriptsFor(composeInput({ pullImages: true }));
		expect(prepare).toContain(
			'pull --ignore-buildable 2>&1 || { echo "Error: ❌ Docker command failed"; exit 1; }',
		);
	});

	test("a docker compose before 2.22 leaves the pulls to `up`", () => {
		const { prepare } = scriptsFor(composeInput(), false, [2, 21, 0]);
		expect(prepare).not.toContain(" pull ");
		expect(prepare).toContain(" build 2>&1");
	});

	test("an untrusted deploy prepares the checked file it runs", () => {
		const { prepare } = scriptsFor(composeInput({}, false));
		expect(prepare).toContain(
			"compose -p shop-abc123 -f /etc/panara-cloud/compose-state/shop-abc123/compose.json build",
		);
	});

	test.each([
		["a custom command", { command: "compose up -d" }],
		["a stack", { composeType: "stack" as const }],
	])("%s is handed over whole", (_, compose) => {
		const { prepare, apply } = scriptsFor(composeInput(compose));
		expect(prepare).not.toMatch(/ (pull|build) /);
		expect(apply).toMatch(/\$DOCKER UP( \))? 2>&1/);
	});
});

// A host that runs `prepare` and `apply` as the tests say; the kill a cancel
// sends is recorded and answers at once.
const fakeHost = (scripts: {
	prepare: () => Promise<ExecResult>;
	apply: () => Promise<ExecResult>;
}) => {
	const ran: string[] = [];
	const host = {
		exec: async (command: string, options?: ExecOptions) => {
			if (command.includes("kill -TERM")) {
				ran.push("kill");
				return { code: 0, output: "" };
			}
			const phase = options?.input === "PREPARE\n" ? "prepare" : "apply";
			ran.push(phase);
			return scripts[phase]();
		},
	} as unknown as Host;
	return { host, ran };
};

const run = (host: Host, signal: AbortSignal) => {
	const lines: string[] = [];
	const done = runDeployScripts(
		host,
		{ prepare: "PREPARE", apply: "APPLY" },
		{ line: (text) => lines.push(text), append: (text) => lines.push(text) },
		signal,
	);
	return { done, lines };
};

describe("a cancel of a compose deploy", () => {
	test("while images are pulled or built stops it before any container is touched", async () => {
		const controller = new AbortController();
		const { host, ran } = fakeHost({
			prepare: async () => {
				controller.abort();
				return { code: 143, output: "Terminated\n" };
			},
			apply: async () => ({ code: 0, output: "" }),
		});
		await expect(run(host, controller.signal).done).rejects.toBeInstanceOf(
			CancelledError,
		);
		expect(ran).toEqual(["prepare", "kill"]);
	});

	test("as the builds finish still stops it before `up`", async () => {
		const controller = new AbortController();
		const { host, ran } = fakeHost({
			prepare: async () => {
				controller.abort();
				return { code: 0, output: "" };
			},
			apply: async () => ({ code: 0, output: "" }),
		});
		await expect(run(host, controller.signal).done).rejects.toBeInstanceOf(
			CancelledError,
		);
		expect(ran).not.toContain("apply");
	});

	test("once `up` runs is too late: it runs to its end and the deploy completes", async () => {
		const controller = new AbortController();
		const { host, ran } = fakeHost({
			prepare: async () => ({ code: 0, output: "" }),
			apply: async () => {
				controller.abort();
				return { code: 0, output: "Docker Compose Deployed: ✅\n" };
			},
		});
		const { done, lines } = run(host, controller.signal);
		await expect(done).resolves.toBeUndefined();
		expect(ran).toEqual(["prepare", "apply"]);
		expect(lines).toEqual([
			"Cancel arrived after docker started replacing containers: the deploy goes on.",
		]);
	});

	test("too late, with an `up` that fails by itself, fails with what went wrong", async () => {
		const controller = new AbortController();
		const { host, ran } = fakeHost({
			prepare: async () => ({ code: 0, output: "" }),
			apply: async () => {
				controller.abort();
				return {
					code: 1,
					output:
						"port is already allocated\nError: ❌ Docker command failed\n",
				};
			},
		});
		await expect(run(host, controller.signal).done).rejects.toSatisfy(
			(error) =>
				error instanceof FailedAfterHandoff &&
				error.message ===
					"port is already allocated\nError: ❌ Docker command failed",
		);
		expect(ran).toEqual(["prepare", "apply"]);
	});
});

describe("what `up` is left with after the pulls and builds", () => {
	const layout = layoutOf(composeInput());
	const up = (pullImages: boolean, version: ComposeVersion | null) =>
		deployCommand(
			{
				appName: "shop-abc123",
				composeType: "docker-compose",
				command: "",
				createEnvFile: true,
				pullImages,
				hasMounts: false,
			},
			layout,
			composePlan(pullImages, version),
		);

	test("it never builds again, so a no_cache build runs once", () => {
		for (const pullImages of [false, true]) {
			for (const version of [CURRENT, [2, 10, 0] as const, null]) {
				const command = up(pullImages, version);
				expect(command).toContain(" up -d --remove-orphans --no-build");
				expect(command).not.toContain("--build ");
			}
		}
	});

	test("with pull images it pulls nothing the strict pull already did", () => {
		expect(up(true, CURRENT)).toBe(
			"compose -p shop-abc123 --env-file .env -f docker-compose.yml up -d --remove-orphans --no-build --pull never",
		);
		expect(up(true, [2, 15, 0])).toMatch(/--pull never$/);
		expect(up(true, [5, 6, 0])).toMatch(/--pull never$/);
	});

	test("a docker compose without `pull --ignore-buildable` (before 2.15) pulls in `up`, as before", () => {
		expect(composePlan(true, [2, 14, 1])).toEqual({
			pull: { args: "pull --ignore-pull-failures", mayFail: true },
			up: "--no-build --pull always",
		});
		expect(composePlan(true, null).up).toBe("--no-build --pull always");
	});

	test("without pull images `up` pulls only what is still missing", () => {
		expect(up(false, CURRENT)).toBe(
			"compose -p shop-abc123 --env-file .env -f docker-compose.yml up -d --remove-orphans --no-build",
		);
		expect(composePlan(false, [2, 22, 0]).pull).toEqual({
			args: "pull --ignore-pull-failures --policy missing",
			mayFail: true,
		});
		expect(composePlan(false, [2, 21, 9]).pull).toBeNull();
	});

	test("reads the version docker compose reports", () => {
		expect(parseComposeVersion("2.40.3\n")).toEqual([2, 40, 3]);
		expect(parseComposeVersion("v2.20.3")).toEqual([2, 20, 3]);
		expect(parseComposeVersion("5.6.0")).toEqual([5, 6, 0]);
		expect(parseComposeVersion("2.24.6-desktop.1")).toEqual([2, 24, 6]);
		expect(
			parseComposeVersion("docker: 'compose' is not a docker command."),
		).toBeNull();
		expect(parseComposeVersion("")).toBeNull();
	});
});
