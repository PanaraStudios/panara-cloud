import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { LATE_CANCEL_NOTE } from "./lib/lease";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	grantMember,
	setup,
	type TestConvex,
} from "./test.setup";

type Kind = "application" | "compose" | "database";
type Status = "idle" | "running" | "done" | "error";
type Lease = { jobId: Id<"jobs">; leaseId: string };

const KINDS: readonly Kind[] = ["application", "compose", "database"];
const NOTHING_DEPLOYED = /Nothing is deployed yet\. Deploy first\./;

const seed = async () => {
	const t = setup();
	// The first membership makes org1 the root organization, whose owner may
	// deploy to the panel host.
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	const alice = asUser(t, "alice");
	const { environmentId } = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "Shop",
	});
	const applicationId = await alice.mutation(
		api.applications.applications.create,
		{ environmentId, name: "Web" },
	);
	await alice.action(api.applications.applications.saveDockerSource, {
		applicationId,
		image: "nginx:alpine",
	});
	const composeId = await alice.mutation(api.compose.crud.create, {
		environmentId,
		name: "Stack",
		composeFile: "services:\n  web:\n    image: nginx:alpine\n",
	});
	const databaseId = await alice.action(api.databases.databases.create, {
		environmentId,
		engine: "postgres",
		name: "Main DB",
	});
	const agent = asAgent(t, await addAgent(t));
	return { t, alice, agent, applicationId, composeId, databaseId };
};

type Seeded = Awaited<ReturnType<typeof seed>>;
type User = ReturnType<typeof asUser>;

const idOf = (s: Seeded, kind: Kind) =>
	kind === "application"
		? s.applicationId
		: kind === "compose"
			? s.composeId
			: s.databaseId;

const deploy = async (s: Seeded, kind: Kind): Promise<Id<"jobs">> => {
	if (kind === "application") {
		const { jobId } = await s.alice.mutation(api.applications.deploy.deploy, {
			applicationId: s.applicationId,
		});
		return jobId;
	}
	if (kind === "compose") {
		const { jobId } = await s.alice.mutation(api.compose.deploy.deploy, {
			composeId: s.composeId,
		});
		return jobId;
	}
	return await s.alice.mutation(api.databases.databases.deploy, {
		databaseId: s.databaseId,
	});
};

// The mutations behind Restart, Start and Stop of each kind.
const lifecycle = (s: Seeded, kind: Kind, user: User = s.alice) =>
	kind === "application"
		? {
				restart: () =>
					user.mutation(api.applications.deploy.reload, {
						applicationId: s.applicationId,
					}),
				start: () =>
					user.mutation(api.applications.deploy.start, {
						applicationId: s.applicationId,
					}),
				stop: () =>
					user.mutation(api.applications.deploy.stop, {
						applicationId: s.applicationId,
					}),
			}
		: kind === "compose"
			? {
					start: () =>
						user.mutation(api.compose.deploy.start, {
							composeId: s.composeId,
						}),
					stop: () =>
						user.mutation(api.compose.deploy.stop, { composeId: s.composeId }),
				}
			: {
					restart: () =>
						user.mutation(api.databases.databases.reload, {
							databaseId: s.databaseId,
						}),
					start: () =>
						user.mutation(api.databases.databases.start, {
							databaseId: s.databaseId,
						}),
					stop: () =>
						user.mutation(api.databases.databases.stop, {
							databaseId: s.databaseId,
						}),
				};

// Claims until `jobId` comes up; anything ahead of it is completed.
const claim = async (s: Seeded, jobId: Id<"jobs">): Promise<Lease> => {
	for (let i = 0; i < 50; i++) {
		const next = await s.agent.mutation(api.agent.claimNext, {});
		if (!next) break;
		const lease = { jobId: next.jobId, leaseId: next.leaseId };
		if (next.jobId === jobId) return lease;
		await s.agent.mutation(api.agent.complete, {
			...lease,
			result: { kind: "none" },
		});
	}
	throw new Error("The job was not queued");
};

// What each kind's handler reports as it starts and as it ends.
const report = async (
	s: Seeded,
	kind: Kind,
	lease: Lease,
	status: "running" | "done" | "error",
) => {
	if (kind === "application") {
		if (status === "running") {
			await s.agent.mutation(api.applications.agent.reportStarted, lease);
		} else {
			await s.agent.mutation(api.applications.agent.reportDeployResult, {
				...lease,
				ok: status === "done",
				...(status === "done"
					? { imageRef: "nginx:alpine" }
					: { error: "The operation was aborted" }),
			});
		}
	} else if (kind === "compose") {
		await s.agent.mutation(api.compose.agent.report, {
			...lease,
			status,
			...(status === "error" ? { error: "The operation was aborted" } : {}),
		});
	} else {
		await s.agent.mutation(api.databases.agent.reportStatus, {
			...lease,
			status,
		});
	}
};

const statusOf = (s: Seeded, kind: Kind): Promise<Status | undefined> =>
	s.t.run(async (ctx) => {
		const row =
			kind === "application"
				? await ctx.db.get("applications", s.applicationId)
				: kind === "compose"
					? await ctx.db.get("compose", s.composeId)
					: await ctx.db.get("databases", s.databaseId);
		return row?.status;
	});

const jobOf = (t: TestConvex, jobId: Id<"jobs">) =>
	t.run((ctx) => ctx.db.get("jobs", jobId));

const jobCount = (t: TestConvex) =>
	t.run(async (ctx) => (await ctx.db.query("jobs").collect()).length);

const notifications = (t: TestConvex) =>
	t.run(async (ctx) =>
		(await ctx.db.system.query("_scheduled_functions").collect()).filter(
			(fn) => fn.name === "platform/notifications:dispatch",
		),
	);

const pending = (s: Seeded, kind: Kind) =>
	s.alice.query(api.serviceEvents.pendingChanges, {
		target: { kind, id: idOf(s, kind) },
	});

const logOf = (s: Seeded, jobId: Id<"jobs">) =>
	s.alice
		.query(api.jobs.logs, { jobId })
		.then((chunks) => chunks.map((chunk) => chunk.text).join(""));

const deploymentOf = async (s: Seeded, kind: Kind) => {
	const [deployment] = await s.alice.query(api.jobs.deployments, {
		organizationId: "org1",
		target: { kind, id: idOf(s, kind) },
	});
	return deployment;
};

// "late": Cancel is pressed while the job runs, and the handler finishes its
// work all the same (the step it was in can't be stopped), so the agent
// reports the result and completes the job.
const runDeploy = async (
	s: Seeded,
	kind: Kind,
	outcome: "succeed" | "fail" | "cancel" | "late",
) => {
	const jobId = await deploy(s, kind);
	const lease = await claim(s, jobId);
	await report(s, kind, lease, "running");
	if (outcome === "late") await s.alice.mutation(api.jobs.cancel, { jobId });
	if (outcome === "succeed" || outcome === "late") {
		await report(s, kind, lease, "done");
		await s.agent.mutation(api.agent.complete, {
			...lease,
			result: { kind: "none" },
		});
		return jobId;
	}
	if (outcome === "cancel") await s.alice.mutation(api.jobs.cancel, { jobId });
	// A handler stopped under it reports the abort like any other error.
	await report(s, kind, lease, "error");
	await s.agent.mutation(api.agent.fail, {
		...lease,
		error: "The operation was aborted",
	});
	return jobId;
};

describe("restart, start and stop need a deploy that succeeded", () => {
	test.each(KINDS)("a new %s refuses them and queues nothing", async (kind) => {
		const s = await seed();
		const before = await jobCount(s.t);
		for (const run of Object.values(lifecycle(s, kind))) {
			await expect(run()).rejects.toThrow(NOTHING_DEPLOYED);
		}
		expect(await jobCount(s.t)).toBe(before);
	});

	test.each(KINDS)(
		"a %s whose first deploy failed still refuses them",
		async (kind) => {
			const s = await seed();
			await runDeploy(s, kind, "fail");
			expect(await statusOf(s, kind)).toBe("error");
			const before = await jobCount(s.t);
			for (const run of Object.values(lifecycle(s, kind))) {
				await expect(run()).rejects.toThrow(NOTHING_DEPLOYED);
			}
			// A member given the service gets the same answer, not a queued job.
			await grantMember(s.t, "org1", "mallory", {
				services: [idOf(s, kind)],
			});
			for (const run of Object.values(
				lifecycle(s, kind, asUser(s.t, "mallory")),
			)) {
				await expect(run()).rejects.toThrow(NOTHING_DEPLOYED);
			}
			expect(await jobCount(s.t)).toBe(before);
		},
	);

	test.each(KINDS)(
		"a %s refuses them while its first deploy runs",
		async (kind) => {
			const s = await seed();
			const lease = await claim(s, await deploy(s, kind));
			await report(s, kind, lease, "running");
			for (const run of Object.values(lifecycle(s, kind))) {
				await expect(run()).rejects.toThrow(NOTHING_DEPLOYED);
			}
		},
	);

	test.each(KINDS)(
		"a deployed %s takes them, also after a later deploy failed",
		async (kind) => {
			const s = await seed();
			await runDeploy(s, kind, "succeed");
			expect(await statusOf(s, kind)).toBe("done");
			await runDeploy(s, kind, "fail");
			expect(await statusOf(s, kind)).toBe("error");
			for (const run of Object.values(lifecycle(s, kind))) {
				const jobId = await run();
				expect((await jobOf(s.t, jobId))?.status).toBe("queued");
			}
		},
	);
});

describe("a deploy its user cancelled did not fail", () => {
	test.each(KINDS)(
		"a cancelled first deploy leaves the %s not deployed, with no failure alert",
		async (kind) => {
			const s = await seed();
			const jobId = await runDeploy(s, kind, "cancel");
			expect((await jobOf(s.t, jobId))?.status).toBe("cancelled");
			expect(await statusOf(s, kind)).toBe("idle");
			expect(await pending(s, kind)).toMatchObject({
				deployState: "never",
				activity: null,
			});
			expect(await notifications(s.t)).toEqual([]);
			const [deployment] = await s.alice.query(api.jobs.deployments, {
				organizationId: "org1",
				target: { kind, id: idOf(s, kind) },
			});
			expect(deployment).toMatchObject({ jobId, status: "cancelled" });
		},
	);

	test.each(KINDS)(
		"a cancel that took effect still reads cancelled, with nothing about a late cancel (%s)",
		async (kind) => {
			const s = await seed();
			const jobId = await runDeploy(s, kind, "cancel");
			expect(await jobOf(s.t, jobId)).toMatchObject({
				status: "cancelled",
				cancelRequested: true,
			});
			expect(await deploymentOf(s, kind)).toMatchObject({
				jobId,
				status: "cancelled",
				lateCancel: false,
			});
			expect(await logOf(s, jobId)).not.toContain(LATE_CANCEL_NOTE);
			expect(await notifications(s.t)).toEqual([]);
		},
	);

	test.each(KINDS)(
		"a cancelled redeploy leaves a live %s live and a stopped one stopped",
		async (kind) => {
			const s = await seed();
			await runDeploy(s, kind, "succeed");
			const alerts = (await notifications(s.t)).length;
			await runDeploy(s, kind, "cancel");
			expect(await statusOf(s, kind)).toBe("done");

			const stop = await claim(s, await lifecycle(s, kind).stop());
			if (kind === "application") {
				await s.agent.mutation(api.applications.agent.reportServiceStatus, {
					...stop,
					status: "idle",
				});
			} else if (kind === "compose") {
				await s.agent.mutation(api.compose.agent.report, {
					...stop,
					status: "idle",
				});
			} else {
				await s.agent.mutation(api.databases.agent.reportStatus, {
					...stop,
					status: "idle",
				});
			}
			await s.agent.mutation(api.agent.complete, {
				...stop,
				result: { kind: "none" },
			});
			await runDeploy(s, kind, "cancel");
			expect(await statusOf(s, kind)).toBe("idle");
			expect(await pending(s, kind)).toMatchObject({ deployState: "deployed" });
			expect(await notifications(s.t)).toHaveLength(alerts);
		},
	);

	test.each(KINDS)(
		"a cancelled deploy after a failed one leaves the %s failed",
		async (kind) => {
			const s = await seed();
			await runDeploy(s, kind, "fail");
			await runDeploy(s, kind, "cancel");
			expect(await statusOf(s, kind)).toBe("error");
		},
	);

	test("a failed deploy with a cancel pending is a cancelled one: no failure alert", async () => {
		const s = await seed();
		for (const kind of ["application", "compose"] as const) {
			const jobId = await deploy(s, kind);
			const lease = await claim(s, jobId);
			await report(s, kind, lease, "running");
			await s.alice.mutation(api.jobs.cancel, { jobId });
			await report(s, kind, lease, "error");
			await s.agent.mutation(api.agent.fail, { ...lease, error: "Cancelled" });
			expect((await jobOf(s.t, jobId))?.status).toBe("cancelled");
		}
		expect(await notifications(s.t)).toEqual([]);
	});

	test("a failed deploy still fails the service and alerts", async () => {
		const s = await seed();
		for (const kind of ["application", "compose"] as const) {
			const before = (await notifications(s.t)).length;
			const jobId = await runDeploy(s, kind, "fail");
			expect((await jobOf(s.t, jobId))?.status).toBe("failed");
			expect(await statusOf(s, kind)).toBe("error");
			expect(await notifications(s.t)).toHaveLength(before + 1);
		}
	});

	test("a start or stop its user cancelled leaves the status alone", async () => {
		const s = await seed();
		await runDeploy(s, "application", "succeed");
		const jobId = await lifecycle(s, "application").stop();
		const lease = await claim(s, jobId);
		await s.alice.mutation(api.jobs.cancel, { jobId });
		await s.agent.mutation(api.applications.agent.reportServiceStatus, {
			...lease,
			status: "error",
		});
		expect(await statusOf(s, "application")).toBe("done");
	});

	test("an application left running by a cancelled deploy whose agent died goes back, a dead deploy fails", async () => {
		const s = await seed();
		const settle = () =>
			s.t.mutation(internal.applications.status.settleStuck, {});
		const strand = async (cancel: boolean) => {
			const jobId = await deploy(s, "application");
			const lease = await claim(s, jobId);
			await report(s, "application", lease, "running");
			if (cancel) await s.alice.mutation(api.jobs.cancel, { jobId });
			// The lease reaper's outcome for a job whose agent never answers.
			await s.t.run(async (ctx) => {
				await ctx.db.patch("jobs", jobId, {
					status: cancel ? "cancelled" : "failed",
					finishedAt: Date.now(),
				});
			});
		};
		await strand(true);
		await settle();
		expect(await statusOf(s, "application")).toBe("idle");
		await strand(false);
		await settle();
		expect(await statusOf(s, "application")).toBe("error");
	});
});

describe("a cancel that came after the work had finished", () => {
	test.each(KINDS)(
		"a first deploy of the %s that finished is recorded as succeeded, and says the cancel was late",
		async (kind) => {
			const s = await seed();
			const jobId = await runDeploy(s, kind, "late");
			const job = await jobOf(s.t, jobId);
			expect(job).toMatchObject({ status: "succeeded", cancelRequested: true });
			expect(job?.error).toBeUndefined();
			// The service follows what is on the host: the new container is up.
			expect(await statusOf(s, kind)).toBe("done");
			expect(await pending(s, kind)).toMatchObject({
				deployState: "deployed",
				activity: null,
			});
			expect(await deploymentOf(s, kind)).toMatchObject({
				jobId,
				status: "succeeded",
				lateCancel: true,
			});
			expect(await logOf(s, jobId)).toContain(LATE_CANCEL_NOTE);
		},
	);

	test.each(KINDS)(
		"a redeploy of the %s that finished is the one that is live",
		async (kind) => {
			const s = await seed();
			const first = await runDeploy(s, kind, "succeed");
			const late = await runDeploy(s, kind, "late");
			expect((await jobOf(s.t, late))?.status).toBe("succeeded");
			expect(await statusOf(s, kind)).toBe("done");
			const history = await s.alice.query(api.jobs.deployments, {
				organizationId: "org1",
				target: { kind, id: idOf(s, kind) },
			});
			expect(
				history.map(({ jobId, status, lateCancel }) => ({
					jobId,
					status,
					lateCancel,
				})),
			).toEqual([
				{ jobId: late, status: "succeeded", lateCancel: true },
				{ jobId: first, status: "succeeded", lateCancel: false },
			]);
			// Restart, start and stop work on it like on any deployed service.
			for (const run of Object.values(lifecycle(s, kind))) {
				expect((await jobOf(s.t, await run()))?.status).toBe("queued");
			}
		},
	);

	test("no failure alert is sent; the deploy's own alert is the success one", async () => {
		const s = await seed();
		for (const kind of KINDS) {
			const before = await notifications(s.t);
			await runDeploy(s, kind, "late");
			const sent = (await notifications(s.t)).slice(before.length);
			const events = sent.map(
				(fn) => (fn.args[0] as { event: { type: string } }).event.type,
			);
			expect(events.filter((type) => /error|fail/i.test(type))).toEqual([]);
			// Applications and compose services announce a deploy; databases don't.
			expect(events).toEqual(
				kind === "application"
					? ["appDeploy"]
					: kind === "compose"
						? ["appDeploy"]
						: [],
			);
		}
	});

	test("the note ends the log after what the agent wrote", async () => {
		const s = await seed();
		const jobId = await deploy(s, "application");
		const lease = await claim(s, jobId);
		await report(s, "application", lease, "running");
		await s.agent.mutation(api.agent.appendLogs, {
			...lease,
			chunks: [
				{ seq: 0, text: "Deploying web with nginx:alpine\n" },
				{ seq: 1, text: "Service web updated ✅" },
			],
		});
		await s.alice.mutation(api.jobs.cancel, { jobId });
		await report(s, "application", lease, "done");
		await s.agent.mutation(api.agent.complete, {
			...lease,
			result: { kind: "none" },
		});
		expect(await logOf(s, jobId)).toBe(
			`Deploying web with nginx:alpine\nService web updated ✅\n${LATE_CANCEL_NOTE}\n`,
		);
		// Completing twice (a retried request) adds nothing.
		await s.agent.mutation(api.agent.complete, {
			...lease,
			result: { kind: "none" },
		});
		expect((await logOf(s, jobId)).split(LATE_CANCEL_NOTE)).toHaveLength(2);
	});

	test("a job that isn't a deploy follows the same rule", async () => {
		const s = await seed();
		await runDeploy(s, "application", "succeed");
		const jobId = await lifecycle(s, "application").stop();
		const lease = await claim(s, jobId);
		await s.alice.mutation(api.jobs.cancel, { jobId });
		await s.agent.mutation(api.applications.agent.reportServiceStatus, {
			...lease,
			status: "idle",
		});
		await s.agent.mutation(api.agent.complete, {
			...lease,
			result: { kind: "none" },
		});
		expect((await jobOf(s.t, jobId))?.status).toBe("succeeded");
		expect(await statusOf(s, "application")).toBe("idle");
		expect(await logOf(s, jobId)).toContain(LATE_CANCEL_NOTE);
	});

	test("a cancel of a job that is still waiting cancels it at once", async () => {
		const s = await seed();
		const jobId = await deploy(s, "application");
		await s.alice.mutation(api.jobs.cancel, { jobId });
		expect(await jobOf(s.t, jobId)).toMatchObject({ status: "cancelled" });
		expect(await deploymentOf(s, "application")).toMatchObject({
			status: "cancelled",
			lateCancel: false,
		});
	});
});

describe("work Docker already had that failed after a cancel was asked", () => {
	test.each(["compose", "database"] as const)(
		"a %s deploy is recorded as failed, not cancelled, and alerts like any failure",
		async (kind) => {
			const s = await seed();
			const before = (await notifications(s.t)).length;
			const jobId = await deploy(s, kind);
			const lease = await claim(s, jobId);
			await report(s, kind, lease, "running");
			await s.alice.mutation(api.jobs.cancel, { jobId });
			const error = "Service did not converge: 0/1 tasks running";
			if (kind === "compose") {
				await s.agent.mutation(api.compose.agent.report, {
					...lease,
					status: "error",
					error,
					despiteCancel: true,
				});
			} else {
				await s.agent.mutation(api.databases.agent.reportStatus, {
					...lease,
					status: "error",
					despiteCancel: true,
				});
			}
			await s.agent.mutation(api.agent.fail, {
				...lease,
				error,
				despiteCancel: true,
			});
			expect(await jobOf(s.t, jobId)).toMatchObject({
				status: "failed",
				error,
				cancelRequested: true,
			});
			expect(await statusOf(s, kind)).toBe("error");
			expect(await deploymentOf(s, kind)).toMatchObject({
				jobId,
				status: "failed",
				lateCancel: false,
			});
			expect(await logOf(s, jobId)).not.toContain(LATE_CANCEL_NOTE);
			// Compose services alert on a failed deploy; databases don't alert.
			expect(await notifications(s.t)).toHaveLength(
				before + (kind === "compose" ? 1 : 0),
			);
		},
	);
});
