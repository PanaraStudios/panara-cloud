import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { enqueueJob } from "../lib/jobs";
import { LOCAL_PARTITION } from "../tables/core";
import { addMember, asUser, setup, type TestConvex } from "../test.setup";
import { installerCommand, panelAddress } from "./webServer";

const setupInstance = async () => {
	const t = setup();
	await addMember(t, "org1", "alice", "owner");
	await addMember(t, "org1", "mallory", "member");
	await addMember(t, "org2", "eve", "owner");
	return t;
};

describe("panel build slots", () => {
	test("instance admins read and set the panel host's concurrency", async () => {
		const t = await setupInstance();
		const alice = asUser(t, "alice");
		expect(
			await alice.query(api.infra.webServer.getLocalBuildsConcurrency),
		).toBe(1);
		await alice.mutation(api.infra.webServer.setLocalBuildsConcurrency, {
			buildsConcurrency: 3,
		});
		expect(
			await alice.query(api.infra.webServer.getLocalBuildsConcurrency),
		).toBe(3);
		await alice.mutation(api.infra.webServer.setLocalBuildsConcurrency, {
			buildsConcurrency: 4,
		});
		const rows = await t.run((ctx) =>
			ctx.db.query("instanceSettings").collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.localBuildsConcurrency).toBe(4);
	});

	test("rejects members, other organizations and out-of-range values", async () => {
		const t = await setupInstance();
		for (const user of ["mallory", "eve"]) {
			await expect(
				asUser(t, user).mutation(
					api.infra.webServer.setLocalBuildsConcurrency,
					{ buildsConcurrency: 2 },
				),
			).rejects.toThrow(/instance administrator/);
			await expect(
				asUser(t, user).query(api.infra.webServer.getLocalBuildsConcurrency),
			).rejects.toThrow(/instance administrator/);
		}
		for (const value of [0, 101, 1.5]) {
			await expect(
				asUser(t, "alice").mutation(
					api.infra.webServer.setLocalBuildsConcurrency,
					{ buildsConcurrency: value },
				),
			).rejects.toThrow(/between 1 and 100/);
		}
	});
});

const queueJob = (
	t: TestConvex,
	organizationId: string,
	usesBuildSlot: boolean,
) =>
	t.run((ctx) =>
		enqueueJob(ctx, {
			organizationId,
			partition: LOCAL_PARTITION,
			group: `test:${Math.random()}`,
			spec: { kind: "noop", message: "x" },
			idempotent: false,
			usesBuildSlot,
		}),
	);

describe("deployment queue", () => {
	test("cancels only the organization's queued builds", async () => {
		const t = await setupInstance();
		const build = await queueJob(t, "org1", true);
		const quick = await queueJob(t, "org1", false);
		const other = await queueJob(t, "org2", true);
		const running = await queueJob(t, "org1", true);
		await t.run((ctx) => ctx.db.patch("jobs", running, { status: "running" }));

		const cancelled = await asUser(t, "alice").mutation(
			api.infra.cleanup.cancelQueuedDeployments,
			{ organizationId: "org1" },
		);
		expect(cancelled).toBe(1);
		const status = async (id: typeof build) =>
			(await t.run((ctx) => ctx.db.get("jobs", id)))?.status;
		expect(await status(build)).toBe("cancelled");
		expect(await status(quick)).toBe("queued");
		expect(await status(other)).toBe("queued");
		expect(await status(running)).toBe("running");
	});

	test("requires an admin of the organization", async () => {
		const t = await setupInstance();
		await queueJob(t, "org1", true);
		for (const user of ["mallory", "eve"]) {
			await expect(
				asUser(t, user).mutation(api.infra.cleanup.cancelQueuedDeployments, {
					organizationId: "org1",
				}),
			).rejects.toThrow();
		}
	});
});

describe("the panel's address and the domain saved in the panel", () => {
	const INSTALLER =
		"curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh";
	const withSite = async <T>(site: string, run: () => Promise<T>) => {
		const before = process.env.SITE_URL;
		process.env.SITE_URL = site;
		try {
			return await run();
		} finally {
			if (before === undefined) delete process.env.SITE_URL;
			else process.env.SITE_URL = before;
		}
	};

	test("agreeing addresses need nothing", () => {
		expect(panelAddress(null, "http://203.0.113.10:3000")).toEqual({
			siteUrl: "http://203.0.113.10:3000",
			pending: null,
		});
		expect(
			panelAddress({ https: false }, "http://localhost:3000").pending,
		).toBe(null);
		expect(
			panelAddress(
				{ host: "panel.example.com", https: true },
				"https://panel.example.com",
			).pending,
		).toBe(null);
		expect(
			panelAddress({ https: false }, "http://[2001:db8::1]:3000").pending,
		).toBe(null);
	});

	test("a domain saved in the panel that the installer has not applied", () => {
		expect(
			panelAddress(
				{
					host: "panel.example.com",
					https: true,
					letsEncryptEmail: "admin@example.com",
				},
				"http://203.0.113.10:3000",
			),
		).toEqual({
			siteUrl: "http://203.0.113.10:3000",
			pending: "domain",
			command: `${INSTALLER} | sudo PANARA_CLOUD_DOMAIN=panel.example.com PANARA_CLOUD_HTTPS=true PANARA_CLOUD_LETSENCRYPT_EMAIL=admin@example.com sh`,
		});
		expect(
			panelAddress(
				{ host: "panel.example.com", https: false },
				"https://panel.example.com",
			).command,
		).toBe(
			`${INSTALLER} | sudo PANARA_CLOUD_DOMAIN=panel.example.com PANARA_CLOUD_HTTPS=false sh`,
		);
		expect(
			panelAddress(
				{ host: "new.example.com", https: true },
				"https://panel.example.com",
			).pending,
		).toBe("domain");
	});

	test("no domain in the panel while the installer serves one", () => {
		expect(panelAddress({ https: false }, "https://panel.example.com")).toEqual(
			{
				siteUrl: "https://panel.example.com",
				pending: "ip",
				command: `${INSTALLER} | sudo PANARA_CLOUD_DOMAIN= sh`,
			},
		);
	});

	test("the command quotes what a shell would act on", () => {
		expect(
			installerCommand({
				host: "panel.example.com",
				https: true,
				letsEncryptEmail: "a'$(id)@example.com",
			}),
		).toBe(
			`${INSTALLER} | sudo PANARA_CLOUD_DOMAIN=panel.example.com PANARA_CLOUD_HTTPS=true PANARA_CLOUD_LETSENCRYPT_EMAIL='a'\\''$(id)@example.com' sh`,
		);
	});

	test("the instance administrator sees it, members don't", async () => {
		const t = await setupInstance();
		await withSite("http://203.0.113.10:3000", async () => {
			await asUser(t, "alice").mutation(api.infra.webServer.assignDomain, {
				host: "panel.example.com",
				https: true,
				certificateType: "letsencrypt",
				letsEncryptEmail: "admin@example.com",
			});
			const admin = await asUser(t, "alice").query(api.infra.webServer.get);
			expect(admin.panelAddress).toMatchObject({
				siteUrl: "http://203.0.113.10:3000",
				pending: "domain",
			});
			expect(admin.panelAddress?.command).toContain(
				"PANARA_CLOUD_DOMAIN=panel.example.com",
			);
			const member = await asUser(t, "mallory").query(api.infra.webServer.get);
			expect(member.host).toBe("panel.example.com");
			expect(member.panelAddress).toBeUndefined();
		});
		await withSite("https://panel.example.com", async () => {
			const admin = await asUser(t, "alice").query(api.infra.webServer.get);
			expect(admin.panelAddress?.pending).toBe(null);
		});
	});

	test("a domain the installer set up can't be removed or changed from the panel", async () => {
		const t = await setupInstance();
		const alice = asUser(t, "alice");
		await withSite("https://panel.example.com", async () => {
			await expect(
				alice.mutation(api.infra.webServer.assignDomain, {
					https: false,
					certificateType: "none",
				}),
			).rejects.toThrow(
				/Removing the domain here would leave the panel unreachable.*PANARA_CLOUD_DOMAIN= sh/,
			);
			await expect(
				alice.mutation(api.infra.webServer.assignDomain, {
					host: "new.example.com",
					https: true,
					certificateType: "letsencrypt",
					letsEncryptEmail: "admin@example.com",
				}),
			).rejects.toThrow(
				/would cut that address off.*PANARA_CLOUD_DOMAIN=new\.example\.com PANARA_CLOUD_HTTPS=true PANARA_CLOUD_LETSENCRYPT_EMAIL=admin@example\.com sh/,
			);
			await expect(
				alice.mutation(api.infra.webServer.assignDomain, {
					host: "panel.example.com",
					https: false,
					certificateType: "none",
				}),
			).rejects.toThrow(/would cut that address off/);
			expect(
				await t.run((ctx) => ctx.db.query("webServerSettings").collect()),
			).toEqual([]);

			await alice.mutation(api.infra.webServer.assignDomain, {
				host: "panel.example.com",
				https: true,
				certificateType: "custom",
			});
			const [saved] = await t.run((ctx) =>
				ctx.db.query("webServerSettings").collect(),
			);
			expect(saved).toMatchObject({
				host: "panel.example.com",
				https: true,
				certificateType: "custom",
			});
		});
	});

	test("on an install reached by IP address the panel's domain can be set and cleared", async () => {
		const t = await setupInstance();
		const alice = asUser(t, "alice");
		await withSite("http://203.0.113.10:3000", async () => {
			await alice.mutation(api.infra.webServer.assignDomain, {
				host: "panel.example.com",
				https: false,
				certificateType: "none",
			});
			await alice.mutation(api.infra.webServer.assignDomain, {
				https: false,
				certificateType: "none",
			});
			const settings = await alice.query(api.infra.webServer.get);
			expect(settings.host).toBeUndefined();
			expect(settings.panelAddress?.pending).toBe(null);
		});
	});
});
