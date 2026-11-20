import { api } from "@panara-cloud/backend/api";
import type { Host } from "../../host/types";
import { runSetupScript, swarmRole, validateServer } from "../../infra/setup";
import {
	ensureTraefik,
	ensureTraefikConfig,
	recreateTraefik,
	writePanelRouting,
} from "../../infra/traefik";
import { updateLetsEncryptEmail } from "../../infra/traefik/config";
import {
	readTraefikState,
	restartTraefik,
} from "../../infra/traefik/container";
import type { JobContext, JobResult } from "../types";
import {
	leaseArgs,
	parseEnv,
	refreshSnapshot,
	specOf,
	withJobHost,
} from "./common";

const traefikOptions = async (ctx: JobContext) => {
	const desired = await ctx.convex.query(
		api.infra.agent.getTraefikDesired,
		leaseArgs(ctx),
	);
	return {
		env: desired.env === null ? null : parseEnv(desired.env),
		additionalPorts: desired.additionalPorts,
		dashboard: desired.dashboardEnabled,
	};
};

const prepareTraefikConfig = async (
	ctx: JobContext,
	host: Host,
	dashboard: boolean,
) => {
	const role = await swarmRole(host);
	const result = await ensureTraefikConfig(host, {
		swarmWorker: role === "worker",
		dashboard,
	});
	if (result.wroteMain) ctx.log.line("Traefik config created ✅");
	if (result.changedMain) {
		ctx.log.line("Traefik main config updated ✅");
	}
	if (result.wroteMiddlewares) ctx.log.line("Default middlewares created ✅");
	return result;
};

const applyWebServer = async (ctx: JobContext, host: Host) => {
	const config = await ctx.convex.query(
		api.infra.agent.getWebServerConfig,
		leaseArgs(ctx),
	);
	await writePanelRouting(host, config);
	ctx.log.line(
		config.host
			? `Panel routed through ${config.host} ✅`
			: "Panel domain removed ✅",
	);
	if (config.letsEncryptEmail) {
		const changed = await updateLetsEncryptEmail(host, config.letsEncryptEmail);
		// Traefik reads the main config only at startup.
		if (changed && (await readTraefikState(host)).exists) {
			ctx.log.line("Let's Encrypt email updated; restarting Traefik");
			await restartTraefik(host);
		}
	}
};

export const serverSetup = async (ctx: JobContext): Promise<JobResult> => {
	specOf(ctx, "infra.serverSetup");
	const setup = await ctx.convex.query(
		api.infra.agent.getSetupContext,
		leaseArgs(ctx),
	);
	const isBuildServer = setup.serverType === "build";
	ctx.log.line(
		isBuildServer
			? "Installing Build Server Dependencies: ✅"
			: "Installing Server Dependencies: ✅",
	);
	await withJobHost(ctx, async (host) => {
		if (setup.customScript) {
			ctx.log.line("Running the server's custom setup script");
			await host.run(setup.customScript, {
				onOutput: (text) => ctx.log.append(text),
				signal: ctx.signal,
			});
		} else {
			await runSetupScript(
				host,
				{
					serverType: setup.serverType,
					advertiseAddr: setup.advertiseAddr,
					swarmPublic: process.env.PANARA_CLOUD_SWARM_PUBLIC === "1",
				},
				(text) => ctx.log.append(text),
				ctx.signal,
			);
		}
		if (!isBuildServer) {
			ctx.log.line("Setting up Traefik");
			const options = await traefikOptions(ctx);
			const config = await prepareTraefikConfig(ctx, host, options.dashboard);
			// Traefik reads its main config only at startup, so a running
			// container must be recreated when that config was (re)written.
			if (
				(config.wroteMain || config.changedMain) &&
				(await readTraefikState(host)).exists
			) {
				await recreateTraefik(host, options, (line) => ctx.log.line(line));
			} else {
				await ensureTraefik(host, options, (line) => ctx.log.line(line));
			}
			if (setup.isLocal) await applyWebServer(ctx, host);
		}
		await refreshSnapshot(ctx, "validate", () => validateServer(host));
	});
	ctx.log.line("Setup Server: ✅");
	return { kind: "none" };
};

export const traefikApply = async (ctx: JobContext): Promise<JobResult> => {
	specOf(ctx, "infra.traefikApply");
	const options = await traefikOptions(ctx);
	await withJobHost(ctx, async (host) => {
		await prepareTraefikConfig(ctx, host, options.dashboard);
		await recreateTraefik(host, options, (line) => ctx.log.line(line));
		await refreshSnapshot(ctx, "traefik", () => readTraefikState(host));
	});
	return { kind: "none" };
};

export const webServerApply = async (ctx: JobContext): Promise<JobResult> => {
	specOf(ctx, "infra.webServerApply");
	await withJobHost(ctx, (host) => applyWebServer(ctx, host));
	return { kind: "none" };
};
