import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
	addAgent,
	addMember,
	asAgent,
	asUser,
	grantMember,
	setup,
	type TestConvex,
} from "../test.setup";

const COMPOSE_FILE = `services:
  web:
    image: nginx:alpine
`;

const seed = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "bob", "member");
	await addMember(t, "org2", "mallory", "owner");
	const alice = asUser(t, "alice");
	const { environmentId } = await alice.mutation(api.projects.create, {
		organizationId: "org1",
		name: "Shop",
	});
	const composeId = await alice.mutation(api.compose.crud.create, {
		environmentId,
		name: "Web stack",
		composeFile: COMPOSE_FILE,
	});
	return {
		t,
		alice,
		bob: asUser(t, "bob"),
		mallory: asUser(t, "mallory"),
		agent: asAgent(t, await addAgent(t)),
		composeId,
	};
};

const finishJob = (
	t: TestConvex,
	jobId: Id<"jobs">,
	status: "succeeded" | "failed" | "running",
) => t.run((ctx) => ctx.db.patch("jobs", jobId, { status }));

const logChunks = (t: TestConvex, jobId: Id<"jobs">) =>
	t.run((ctx) =>
		ctx.db
			.query("jobLogChunks")
			.withIndex("by_jobId_and_seq", (q) => q.eq("jobId", jobId))
			.collect(),
	);

const addLog = (t: TestConvex, jobId: Id<"jobs">) =>
	t.run((ctx) =>
		ctx.db.insert("jobLogChunks", { jobId, seq: 0, text: "building\n" }),
	);

describe("compose deployments", () => {
	test("clearDeployments keeps running runs and the latest success, and purges logs", async () => {
		const s = await seed();
		const runs = [];
		for (let i = 0; i < 4; i++) {
			runs.push(
				await s.alice.mutation(api.compose.deploy.deploy, {
					composeId: s.composeId,
				}),
			);
		}
		const [oldSuccess, failed, latestSuccess, running] = runs as {
			jobId: Id<"jobs">;
			deploymentId: Id<"deployments">;
		}[];
		await finishJob(s.t, oldSuccess.jobId, "succeeded");
		await finishJob(s.t, failed.jobId, "failed");
		await finishJob(s.t, latestSuccess.jobId, "succeeded");
		await finishJob(s.t, running.jobId, "running");
		await addLog(s.t, oldSuccess.jobId);

		await expect(
			s.mallory.mutation(api.compose.deploy.clearDeployments, {
				composeId: s.composeId,
			}),
		).rejects.toThrow(/Not a member/);

		await expect(
			s.bob.mutation(api.compose.deploy.clearDeployments, {
				composeId: s.composeId,
			}),
		).rejects.toThrow(/access to this service/);
		await grantMember(s.t, "org1", "bob", { services: [s.composeId] });
		expect(
			await s.bob.mutation(api.compose.deploy.clearDeployments, {
				composeId: s.composeId,
			}),
		).toEqual({ removed: 2 });
		await s.t.finishAllScheduledFunctions(() => {});
		const left = await s.alice.query(api.compose.deploy.listDeployments, {
			composeId: s.composeId,
		});
		expect(left.map((row) => row._id).sort()).toEqual(
			[latestSuccess.deploymentId, running.deploymentId].sort(),
		);
		expect(await logChunks(s.t, oldSuccess.jobId)).toEqual([]);
	});

	test("removeDeployment deletes a finished compose deployment only", async () => {
		const s = await seed();
		const { jobId, deploymentId } = await s.alice.mutation(
			api.compose.deploy.deploy,
			{ composeId: s.composeId },
		);
		await expect(
			s.alice.mutation(api.compose.deploy.removeDeployment, { deploymentId }),
		).rejects.toThrow(/Cancel the deployment/);
		await finishJob(s.t, jobId, "failed");
		await expect(
			s.mallory.mutation(api.compose.deploy.removeDeployment, {
				deploymentId,
			}),
		).rejects.toThrow(/Not a member/);
		const appDeployment = await s.t.run((ctx) =>
			ctx.db.insert("deployments", {
				organizationId: "org1",
				jobId,
				target: { kind: "application", id: "app1" },
				title: "x",
			}),
		);
		await expect(
			s.alice.mutation(api.compose.deploy.removeDeployment, {
				deploymentId: appDeployment,
			}),
		).rejects.toThrow(/Not a compose deployment/);
		await expect(
			s.bob.mutation(api.compose.deploy.removeDeployment, { deploymentId }),
		).rejects.toThrow(/access to this service/);
		await grantMember(s.t, "org1", "bob", { services: [s.composeId] });
		await s.bob.mutation(api.compose.deploy.removeDeployment, {
			deploymentId,
		});
		expect(
			await s.t.run((ctx) => ctx.db.get("deployments", deploymentId)),
		).toBeNull();
	});
});

describe("compose settings", () => {
	test("update sets and clears the icon", async () => {
		const s = await seed();
		const icon = `data:image/svg+xml;base64,${btoa("<svg/>")}`;
		await s.alice.mutation(api.compose.crud.update, {
			composeId: s.composeId,
			icon,
		});
		expect(
			(await s.alice.query(api.compose.crud.get, { composeId: s.composeId }))
				?.icon,
		).toBe(icon);
		await expect(
			s.alice.mutation(api.compose.crud.update, {
				composeId: s.composeId,
				icon: "javascript:alert(1)",
			}),
		).rejects.toThrow(/image data URL or a URL/);
		await expect(
			s.alice.mutation(api.compose.crud.update, {
				composeId: s.composeId,
				icon: `data:image/png;base64,${"A".repeat(140 * 1024)}`,
			}),
		).rejects.toThrow(/too large/);
		await expect(
			s.mallory.mutation(api.compose.crud.update, {
				composeId: s.composeId,
				icon,
			}),
		).rejects.toThrow(/Not a member/);
		await s.alice.mutation(api.compose.crud.update, {
			composeId: s.composeId,
			icon: null,
		});
		expect(
			(await s.alice.query(api.compose.crud.get, { composeId: s.composeId }))
				?.icon,
		).toBeUndefined();
	});

	test("randomize gets a suffix, and renaming a deployed stack's volumes needs a confirmation", async () => {
		const s = await seed();
		await s.alice.mutation(api.compose.crud.update, {
			composeId: s.composeId,
			randomize: true,
		});
		const randomized = await s.t.run((ctx) =>
			ctx.db.get("compose", s.composeId),
		);
		expect(randomized?.suffix).toMatch(/^[0-9a-f]{8}$/);
		await s.t.run((ctx) =>
			ctx.db.patch("compose", s.composeId, { status: "done" }),
		);
		for (const fields of [
			{ randomize: false },
			{ suffix: "other" },
			{ isolatedDeployment: true, isolatedDeploymentsVolume: true },
		]) {
			await expect(
				s.alice.mutation(api.compose.crud.update, {
					composeId: s.composeId,
					...fields,
				}),
			).rejects.toThrow(/renames the stack's volumes/);
		}
		// Settings that keep the volume names need no confirmation.
		await s.alice.mutation(api.compose.crud.update, {
			composeId: s.composeId,
			isolatedDeployment: false,
			pullImages: true,
		});
		await s.alice.mutation(api.compose.crud.update, {
			composeId: s.composeId,
			randomize: false,
			confirmVolumeRename: true,
		});
		expect(
			(await s.t.run((ctx) => ctx.db.get("compose", s.composeId)))?.randomize,
		).toBe(false);
	});

	test("git sources keep a safe build path", async () => {
		const s = await seed();
		const source = (buildPath: string) => ({
			type: "git" as const,
			gitSource: {
				type: "git" as const,
				url: "https://example.com/acme/web.git",
				branch: "main",
				buildPath,
				submodules: false,
			},
		});
		await s.alice.mutation(api.compose.crud.setSource, {
			composeId: s.composeId,
			source: source("deploy/prod/"),
		});
		const compose = await s.alice.query(api.compose.crud.get, {
			composeId: s.composeId,
		});
		expect(compose?.gitSource?.buildPath).toBe("deploy/prod/");
		await expect(
			s.alice.mutation(api.compose.crud.setSource, {
				composeId: s.composeId,
				source: source("../etc"),
			}),
		).rejects.toThrow(/Build path must stay inside the repository/);
	});
});

describe("compose previews of unsaved settings", () => {
	test("convert carries randomize and isolation overrides to the agent context", async () => {
		const s = await seed();
		await expect(
			s.mallory.mutation(api.compose.deploy.convert, {
				composeId: s.composeId,
				randomize: true,
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			s.alice.mutation(api.compose.deploy.convert, {
				composeId: s.composeId,
				randomize: true,
				suffix: "bad suffix!",
			}),
		).rejects.toThrow(/Suffix can only contain/);

		const { jobId } = await s.alice.mutation(api.compose.deploy.convert, {
			composeId: s.composeId,
			randomize: true,
			suffix: "",
		});
		const claimed = await s.agent.mutation(api.agent.claimNext, {});
		expect(claimed?.jobId).toBe(jobId);
		const spec = claimed?.spec as {
			overrides?: { randomize?: boolean; suffix?: string };
		};
		expect(spec.overrides?.randomize).toBe(true);
		expect(spec.overrides?.suffix).toMatch(/^[0-9a-f]{8}$/);
		const context = await s.agent.query(api.compose.agent.getContext, {
			jobId,
			leaseId: claimed?.leaseId ?? "",
		});
		expect(context?.compose).toMatchObject({
			randomize: true,
			suffix: spec.overrides?.suffix,
			isolatedDeployment: false,
		});
		const saved = await s.alice.query(api.compose.crud.get, {
			composeId: s.composeId,
		});
		expect(saved).toMatchObject({ randomize: false, suffix: "" });

		await finishJob(s.t, jobId, "succeeded");
		await s.alice.mutation(api.compose.deploy.convert, {
			composeId: s.composeId,
			isolatedDeployment: true,
		});
		const isolated = await s.agent.mutation(api.agent.claimNext, {});
		const isolatedContext = await s.agent.query(api.compose.agent.getContext, {
			jobId: isolated?.jobId as Id<"jobs">,
			leaseId: isolated?.leaseId ?? "",
		});
		expect(isolatedContext?.compose).toMatchObject({
			isolatedDeployment: true,
			randomize: false,
		});
	});

	test("a plain convert previews the saved settings", async () => {
		const s = await seed();
		await s.alice.mutation(api.compose.crud.update, {
			composeId: s.composeId,
			randomize: true,
			suffix: "prod",
		});
		const { jobId } = await s.alice.mutation(api.compose.deploy.convert, {
			composeId: s.composeId,
		});
		const claimed = await s.agent.mutation(api.agent.claimNext, {});
		expect(claimed?.spec).not.toHaveProperty("overrides");
		const context = await s.agent.query(api.compose.agent.getContext, {
			jobId,
			leaseId: claimed?.leaseId ?? "",
		});
		expect(context?.compose).toMatchObject({ randomize: true, suffix: "prod" });
	});

	test("processTemplate is authorized against the compose", async () => {
		const s = await seed();
		const base64 = btoa(JSON.stringify({ compose: COMPOSE_FILE, config: "" }));
		await expect(
			s.mallory.action(api.compose.templates.processTemplate, {
				composeId: s.composeId,
				base64,
			}),
		).rejects.toThrow(/Not a member/);
		await expect(
			s.alice.action(api.compose.templates.processTemplate, {
				composeId: s.composeId,
				base64: "not base64 json",
			}),
		).rejects.toThrow(/Invalid template format/);
	});
});
