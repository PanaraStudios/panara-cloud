import type Dockerode from "dockerode";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Host } from "../host/types";
import { FailedAfterHandoff } from "../lib/handoff";
import { type DatabaseServiceInput, deployDatabase } from "./service";

const input: DatabaseServiceInput = {
	databaseId: "db1",
	organizationId: "org1",
	projectId: "p1",
	environmentId: "e1",
	engine: "postgres",
	name: "Main",
	appName: "main-abc123",
	dockerImage: "postgres:17",
	replicas: 1,
	env: "",
	projectEnv: "",
	environmentEnv: "",
	credentials: { databaseName: "shop", databaseUser: "shop", password: "pw" },
	mounts: [],
};

// A host whose pull ends as `pull` says and whose Swarm runs the service's
// task once `startsAfter` polls have looked at it (never, when null). With
// `crashLoop` every look finds a new task that has just started, and the one
// before it failed: a container that exits as soon as it starts. With
// `crashAfter` each task runs for that many looks, then fails and Swarm
// starts the next one. `probe` answers the readiness check run in a task's
// container (ready by default).
const fakeHost = (options: {
	pull?: (signal?: AbortSignal) => Promise<void>;
	onCreate?: () => void;
	startsAfter: number | null;
	crashLoop?: boolean;
	crashAfter?: number;
	probe?: (containerId: string) => { code: number | null; output: string };
}) => {
	const calls: string[] = [];
	const probes: string[] = [];
	let polls = 0;
	const docker = {
		getService: () => ({
			inspect: async () => {
				if (!calls.includes("create")) {
					throw Object.assign(new Error("no such service"), {
						statusCode: 404,
					});
				}
				return { Spec: { Mode: { Replicated: { Replicas: 1 } } } };
			},
		}),
		createService: async () => {
			calls.push("create");
			options.onCreate?.();
		},
		listTasks: async () => {
			polls++;
			if (options.crashLoop) {
				return [
					{
						ID: `task-${polls}`,
						DesiredState: "running",
						Status: { State: "running" },
					},
					{
						ID: `task-${polls - 1}`,
						DesiredState: "shutdown",
						Status: { State: "failed", Err: "task: non-zero exit (7)" },
					},
				];
			}
			if (options.crashAfter !== undefined) {
				const generation = Math.floor((polls - 1) / options.crashAfter);
				return [
					{
						ID: `task-${generation}`,
						DesiredState: "running",
						Status: {
							State: "running",
							ContainerStatus: { ContainerID: `container-${generation}` },
						},
					},
					...(generation > 0
						? [
								{
									ID: `task-${generation - 1}`,
									DesiredState: "shutdown",
									Status: { State: "failed", Err: "task: non-zero exit (1)" },
								},
							]
						: []),
				];
			}
			const running =
				options.startsAfter !== null && polls > options.startsAfter;
			return [
				{
					ID: "task-1",
					DesiredState: "running",
					Status: running
						? {
								State: "running",
								ContainerStatus: { ContainerID: "container-1" },
							}
						: { State: "failed", Err: "task: non-zero exit (1)" },
				},
			];
		},
	};
	const host = {
		kind: "local",
		label: "test",
		run: async (command: string, runOptions?: { signal?: AbortSignal }) => {
			calls.push(command.split(" ").slice(0, 2).join(" "));
			await options.pull?.(runOptions?.signal);
			return "";
		},
		exec: async (command: string) => {
			const containerId = command.split(" ")[2] ?? "";
			probes.push(containerId);
			return options.probe?.(containerId) ?? { code: 0, output: "" };
		},
		docker: () => docker as unknown as Dockerode,
	} as unknown as Host;
	return { host, calls, probes };
};

const deploy = (host: Host, signal: AbortSignal, lines: string[]) =>
	deployDatabase(host, input, {
		log: (text) => lines.push(text),
		signal,
		trusted: true,
	});

afterEach(() => {
	vi.useRealTimers();
});

describe("a cancel of a database deploy", () => {
	test("before the service is created or updated stops the deploy", async () => {
		const controller = new AbortController();
		const { host, calls } = fakeHost({
			pull: async () => controller.abort(),
			startsAfter: 0,
		});
		await expect(deploy(host, controller.signal, [])).rejects.toThrow(
			"Cancelled",
		);
		expect(calls).toEqual(["docker pull"]);
	});

	test("once Swarm has the service is too late: the deploy waits for it and completes", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const lines: string[] = [];
		const { host, calls } = fakeHost({
			onCreate: () => controller.abort(),
			startsAfter: 2,
		});
		const done = deploy(host, controller.signal, lines);
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(done).resolves.toBeUndefined();
		expect(calls).toEqual(["docker pull", "create"]);
		expect(lines).toEqual([
			"Pulling postgres:17\n",
			"Cancel arrived after the service was updated: Swarm is starting it, so the deploy goes on.\n",
			"Service main-abc123 created\n",
			"Waiting for PostgreSQL to accept connections\n",
			"PostgreSQL accepts connections\n",
			"Deployment completed successfully!\n",
		]);
	});

	test("too late, with a service that never starts, fails with what went wrong", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const { host } = fakeHost({
			onCreate: () => controller.abort(),
			startsAfter: null,
		});
		const done = deploy(host, controller.signal, []);
		const settled = expect(done).rejects.toSatisfy(
			(error) =>
				error instanceof FailedAfterHandoff &&
				error.message ===
					"Service main-abc123 did not converge: 0/1 tasks running (last state: task: non-zero exit (1))",
		);
		await vi.advanceTimersByTimeAsync(200_000);
		await settled;
	});

	test("a container that exits as soon as it starts is not a database that came up", async () => {
		vi.useFakeTimers();
		const lines: string[] = [];
		const { host } = fakeHost({ startsAfter: null, crashLoop: true });
		const done = deploy(host, new AbortController().signal, lines);
		// Every look catches the newest task "running"; none is still there at
		// the next one.
		const settled = expect(done).rejects.toThrow(
			"Service main-abc123 did not converge: 0/1 tasks running (last state: task: non-zero exit (7))",
		);
		await vi.advanceTimersByTimeAsync(200_000);
		await settled;
		expect(lines).not.toContain("Deployment completed successfully!\n");
	});

	test("a task that is still running at the next look is one", async () => {
		vi.useFakeTimers();
		const lines: string[] = [];
		const { host } = fakeHost({ startsAfter: 0 });
		const done = deploy(host, new AbortController().signal, lines);
		await vi.advanceTimersByTimeAsync(1_900);
		expect(lines).not.toContain("Deployment completed successfully!\n");
		await vi.advanceTimersByTimeAsync(200);
		await expect(done).resolves.toBeUndefined();
		expect(lines.at(-1)).toBe("Deployment completed successfully!\n");
	});
});

describe("a database's start check", () => {
	const started = (lines: string[]) =>
		lines.includes("Deployment completed successfully!\n");

	test("a healthy database is done as soon as it accepts connections", async () => {
		vi.useFakeTimers();
		const lines: string[] = [];
		const { host, probes } = fakeHost({ startsAfter: 0 });
		const done = deploy(host, new AbortController().signal, lines);
		await vi.advanceTimersByTimeAsync(2_100);
		await expect(done).resolves.toBeUndefined();
		expect(probes).toEqual(["container-1"]);
	});

	test("waits while the server initialises, then completes", async () => {
		vi.useFakeTimers();
		const lines: string[] = [];
		let tries = 0;
		const { host } = fakeHost({
			startsAfter: 0,
			probe: () =>
				++tries < 4
					? { code: 2, output: "127.0.0.1:5432 - no response" }
					: { code: 0, output: "" },
		});
		const done = deploy(host, new AbortController().signal, lines);
		await vi.advanceTimersByTimeAsync(6_100);
		expect(started(lines)).toBe(false);
		await vi.advanceTimersByTimeAsync(2_000);
		await expect(done).resolves.toBeUndefined();
	});

	test("a database that crashes a few seconds after it starts is not deployed", async () => {
		vi.useFakeTimers();
		const lines: string[] = [];
		// Each container runs for about 8 s (four looks), reading a bad
		// setting, and exits before it ever accepts a connection.
		const { host } = fakeHost({
			startsAfter: null,
			crashAfter: 4,
			probe: () => ({ code: 2, output: "127.0.0.1:5432 - no response" }),
		});
		const done = deploy(host, new AbortController().signal, lines);
		const settled = expect(done).rejects.toThrow(
			"Service main-abc123 started but the database did not come up within 180s (PostgreSQL: 127.0.0.1:5432 - no response) (last state: task: non-zero exit (1))",
		);
		await vi.advanceTimersByTimeAsync(200_000);
		await settled;
		expect(started(lines)).toBe(false);
	});

	test("without a probe, a container that crashes within 15 s doesn't count", async () => {
		vi.useFakeTimers();
		const lines: string[] = [];
		const { host, probes } = fakeHost({ startsAfter: null, crashAfter: 5 });
		const done = deployDatabase(
			host,
			{ ...input, command: "postgres -c config_file=/etc/custom.conf" },
			{ log: (text) => lines.push(text), trusted: true },
		);
		const settled = expect(done).rejects.toThrow(
			"Service main-abc123 started but the database did not come up within 180s (last state: task: non-zero exit (1))",
		);
		await vi.advanceTimersByTimeAsync(200_000);
		await settled;
		expect(probes).toEqual([]);
		expect(lines).toContain("Waiting until the database has run for 15s\n");
	});

	test("an image without the probe's tool falls back to the uptime check", async () => {
		vi.useFakeTimers();
		const lines: string[] = [];
		const { host, probes } = fakeHost({
			startsAfter: 0,
			probe: () => ({ code: 127, output: "" }),
		});
		const done = deploy(host, new AbortController().signal, lines);
		await vi.advanceTimersByTimeAsync(14_000);
		expect(started(lines)).toBe(false);
		await vi.advanceTimersByTimeAsync(4_000);
		await expect(done).resolves.toBeUndefined();
		// Asked once; the task's image can't answer.
		expect(probes).toEqual(["container-1"]);
		expect(lines).not.toContain("PostgreSQL accepts connections\n");
	});

	test("a task on another node of the swarm gets the uptime check", async () => {
		vi.useFakeTimers();
		const lines: string[] = [];
		const { host } = fakeHost({
			startsAfter: 0,
			probe: () => ({
				code: 1,
				output: "Error response from daemon: No such container: container-1",
			}),
		});
		const done = deploy(host, new AbortController().signal, lines);
		await vi.advanceTimersByTimeAsync(18_000);
		await expect(done).resolves.toBeUndefined();
	});
});
