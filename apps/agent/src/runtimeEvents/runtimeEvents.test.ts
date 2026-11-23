import { describe, expect, test } from "vitest";
import type { ExecOptions, ExecResult, Host } from "../host/types";
import {
	RuntimeClassifier,
	type RuntimeReport,
	RuntimeReporter,
	type RuntimeSignal,
	runtimeEventsCommand,
	serviceOf,
} from "./classify";
import { HostEventWatcher } from "./watcher";

const labels = {
	"panara-cloud.managed": "true",
	"panara-cloud.service.kind": "application",
	"panara-cloud.service.id": "app1",
};

let nano = 1_700_000_000_000_000_000;
const event = (
	action: string,
	attributes: Record<string, string> = {},
	containerId = "c1",
) => {
	nano += 1_000_000_000;
	return {
		Type: "container",
		Action: action,
		Actor: {
			ID: containerId,
			Attributes: { ...labels, name: "app-web.1.x", ...attributes },
		},
		time: Math.floor(nano / 1e9),
		timeNano: nano,
	};
};

describe("runtime event classification", () => {
	test("follows only labelled container events", () => {
		expect(runtimeEventsCommand()).toBe(
			"docker events --format '{{json .}}' --filter type=container --filter event\\=die --filter event\\=oom --filter event\\=kill --filter event\\=health_status --filter label\\=panara-cloud.service.id",
		);
		expect(runtimeEventsCommand(1700000000.7)).toMatch(/ --since 1700000000$/);
		expect(runtimeEventsCommand(undefined, 1800)).toMatch(
			/^timeout 1800 docker events /,
		);
	});

	test("maps containers to services by their labels", () => {
		expect(serviceOf(labels)).toEqual({ kind: "application", id: "app1" });
		expect(
			serviceOf({
				"panara-cloud.service.kind": "database",
				"panara-cloud.service.id": "db1",
			}),
		).toEqual({ kind: "database", id: "db1" });
		expect(
			serviceOf({
				"panara-cloud.service.kind": "preview",
				"panara-cloud.service.id": "p1",
			}),
		).toBeNull();
		expect(serviceOf({ "com.docker.compose.project": "shop" })).toBeNull();
		expect(serviceOf(undefined)).toBeNull();
	});

	test("reports crashes but not clean exits or intentional stops", () => {
		const classifier = new RuntimeClassifier();
		expect(classifier.classify(event("die", { exitCode: "3" }))).toMatchObject({
			target: { kind: "application", id: "app1" },
			type: "runtime.crashed",
			exitCode: 3,
			container: "app-web.1.x",
		});
		expect(classifier.classify(event("die", { exitCode: "0" }))).toBeNull();
		expect(
			classifier.classify(event("kill", { signal: "15" }, "c2")),
		).toBeNull();
		expect(
			classifier.classify(event("die", { exitCode: "143" }, "c2")),
		).toBeNull();
		// The kill is forgotten once its die was seen.
		expect(
			classifier.classify(event("die", { exitCode: "1" }, "c2")),
		).toMatchObject({ type: "runtime.crashed", exitCode: 1 });
	});

	test("an OOM kill is one event, not also a crash", () => {
		const classifier = new RuntimeClassifier();
		expect(classifier.classify(event("oom"))).toMatchObject({
			type: "runtime.oomKilled",
		});
		expect(classifier.classify(event("die", { exitCode: "137" }))).toBeNull();
	});

	test("reports failing health checks only", () => {
		const classifier = new RuntimeClassifier();
		expect(
			classifier.classify(event("health_status: unhealthy")),
		).toMatchObject({ type: "runtime.unhealthy" });
		expect(classifier.classify(event("health_status: healthy"))).toBeNull();
	});

	test("ignores replayed and foreign events", () => {
		const classifier = new RuntimeClassifier();
		const crash = event("die", { exitCode: "2" });
		expect(classifier.classify(crash)).not.toBeNull();
		expect(classifier.classify(crash)).toBeNull();
		expect(
			classifier.classify({
				Type: "container",
				Action: "die",
				Actor: { ID: "x", Attributes: { exitCode: "1", name: "shop-api" } },
			}),
		).toBeNull();
	});
});

const signal = (
	type: RuntimeSignal["type"],
	at: number,
	exitCode?: number,
): RuntimeSignal => ({
	target: { kind: "compose", id: "c1" },
	type,
	exitCode,
	at,
});

describe("runtime reporter", () => {
	test("debounces restart loops into counted reports", async () => {
		let now = 0;
		const sent: RuntimeReport[][] = [];
		const reporter = new RuntimeReporter(
			async (reports) => {
				sent.push(reports);
			},
			{ minIntervalMs: 60_000, maxPending: 10 },
			() => now,
		);
		reporter.add(signal("runtime.crashed", 1, 1));
		await reporter.flush();
		expect(sent).toEqual([
			[expect.objectContaining({ count: 1, exitCode: 1 })],
		]);
		for (let i = 0; i < 5; i++) {
			now += 5_000;
			reporter.add(signal("runtime.crashed", now, 2));
			await reporter.flush();
		}
		reporter.add(signal("runtime.oomKilled", now));
		await reporter.flush();
		expect(sent).toHaveLength(2);
		expect(sent[1]).toEqual([
			expect.objectContaining({ type: "runtime.oomKilled", count: 1 }),
		]);
		now = 61_000;
		await reporter.flush();
		expect(sent[2]).toEqual([
			expect.objectContaining({
				type: "runtime.crashed",
				count: 5,
				exitCode: 2,
				at: 25_000,
			}),
		]);
		expect(reporter.size).toBe(0);
	});

	test("keeps reports for the next flush when sending fails", async () => {
		let fail = true;
		const sent: RuntimeReport[][] = [];
		const reporter = new RuntimeReporter(
			async (reports) => {
				if (fail) throw new Error("offline");
				sent.push(reports);
			},
			{ minIntervalMs: 60_000, maxPending: 10 },
			() => 0,
		);
		reporter.add(signal("runtime.crashed", 0, 1));
		await expect(reporter.flush()).rejects.toThrow("offline");
		reporter.add(signal("runtime.crashed", 0, 1));
		fail = false;
		await reporter.flush();
		expect(sent).toEqual([[expect.objectContaining({ count: 2 })]]);
	});

	test("caps what it holds", () => {
		const reporter = new RuntimeReporter(async () => {}, {
			minIntervalMs: 1,
			maxPending: 1,
		});
		reporter.add(signal("runtime.crashed", 0));
		reporter.add(signal("runtime.oomKilled", 0));
		expect(reporter.size).toBe(1);
	});
});

type Script = (options: ExecOptions) => Promise<ExecResult>;

const fakeHost = (script: Script, commands: string[]): Host =>
	({
		kind: "local",
		label: "fake",
		exec: (command: string, options: ExecOptions = {}) => {
			commands.push(command);
			return script(options);
		},
		close: () => {},
	}) as unknown as Host;

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

describe("host event watcher", () => {
	test("reconnects with backoff, resumes with --since and stops cleanly", async () => {
		const commands: string[] = [];
		const sleeps: number[] = [];
		const logs: string[] = [];
		const signals: RuntimeSignal[] = [];
		let now = 1_700_000_100_000;
		const crash = event("die", { exitCode: "1" }, "c9");
		const attempts: (() => Promise<Host>)[] = [
			async () =>
				fakeHost(async ({ onOutput }) => {
					const text = line(crash);
					// Split mid-line: output arrives in arbitrary chunks.
					onOutput?.(text.slice(0, 20));
					onOutput?.(text.slice(20));
					onOutput?.("not json\n");
					return { code: 1, output: "Cannot connect to the Docker daemon" };
				}, commands),
			async () => {
				throw new Error("connect ECONNREFUSED");
			},
			async () =>
				fakeHost(
					({ onOutput, signal }) =>
						new Promise((resolve) => {
							// Docker replays the crash (same second) after --since.
							onOutput?.(line(crash));
							signal?.addEventListener("abort", () =>
								resolve({ code: null, output: "" }),
							);
						}),
					commands,
				),
		];
		let reachedLast!: () => void;
		const ready = new Promise<void>((resolve) => {
			reachedLast = resolve;
		});
		const watcher = new HostEventWatcher({
			label: "edge",
			connect: async () => {
				const next = attempts.shift();
				if (!next) throw new Error("no more attempts");
				if (attempts.length === 0) reachedLast();
				return next();
			},
			onSignal: (s) => signals.push(s),
			log: (message) => logs.push(message),
			initialBackoffMs: 1000,
			now: () => now,
			sleep: async (ms) => {
				sleeps.push(ms);
				now += ms;
			},
		});
		await ready;
		await new Promise((resolve) => setTimeout(resolve, 0));
		watcher.stop();
		await watcher.done;

		expect(signals).toEqual([
			expect.objectContaining({ type: "runtime.crashed", exitCode: 1 }),
		]);
		expect(sleeps).toEqual([1000, 2000]);
		expect(commands[0]).not.toContain("--since");
		expect(commands[1]).toContain(`--since ${crash.time}`);
		expect(commands[0]).toMatch(/^timeout 1800 docker events /);
		expect(logs[0]).toMatch(
			/edge.*exited with 1: Cannot connect to the Docker daemon; retrying in 1s/,
		);
		expect(logs).toContain("Runtime events (edge): reconnected");
	});

	test("rotates long streams without backoff, resuming where it left off", async () => {
		const commands: string[] = [];
		const sleeps: number[] = [];
		const signals: RuntimeSignal[] = [];
		const crash = event("die", { exitCode: "1" }, "c8");
		let connects = 0;
		let rotatedTwice!: () => void;
		const twice = new Promise<void>((resolve) => {
			rotatedTwice = resolve;
		});
		const watcher = new HostEventWatcher({
			label: "edge",
			connect: async () => {
				connects++;
				if (connects === 3) rotatedTwice();
				return fakeHost(
					({ onOutput, signal }) =>
						new Promise((resolve) => {
							onOutput?.(line(crash));
							signal?.addEventListener("abort", () =>
								resolve({ code: null, output: "" }),
							);
						}),
					commands,
				);
			},
			onSignal: (s) => signals.push(s),
			log: () => {},
			maxStreamMs: 5,
			now: () => crash.time * 1000 + 1000,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		await twice;
		watcher.stop();
		await watcher.done;
		expect(sleeps).toEqual([]);
		expect(signals).toHaveLength(1);
		expect(commands[0]).not.toContain("--since");
		expect(commands[1]).toContain(`--since ${crash.time}`);
		expect(commands[0]).toMatch(/^timeout 1 docker events /);
	});

	test("a throwing signal handler doesn't stop the stream", () => {
		const logs: string[] = [];
		const watcher = new HostEventWatcher({
			label: "panel host",
			connect: () => new Promise(() => {}),
			onSignal: () => {
				throw new Error("boom");
			},
			log: (message) => logs.push(message),
		});
		watcher.handleLine(JSON.stringify(event("die", { exitCode: "4" }, "c7")));
		watcher.stop();
		expect(logs).toEqual(["Runtime events (panel host): boom"]);
	});
});
