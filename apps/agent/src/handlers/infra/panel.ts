import { api } from "@panara-cloud/backend/api";
import {
	checkForUpdate,
	detectPublicIp,
	readPanelConfig,
	readPanelStatus,
	reloadPanel,
	setPanelPort,
	updatePanel,
} from "../../infra/panel";
import { setupScript } from "../../infra/setup";
import type { JobContext, JobResult } from "../types";
import {
	errorMessage,
	leaseArgs,
	refreshSnapshot,
	reportOpResult,
	specOf,
	withJobHost,
} from "./common";

const withOpResult = async (
	ctx: JobContext,
	run: () => Promise<unknown>,
): Promise<JobResult> => {
	try {
		await reportOpResult(ctx, (await run()) ?? null);
	} catch (error) {
		await reportOpResult(ctx, undefined, errorMessage(error)).catch(() => {});
		throw error;
	}
	return { kind: "none" };
};

export const panelAction = async (ctx: JobContext): Promise<JobResult> => {
	const { action } = specOf(ctx, "infra.panelAction");
	const log = (line: string) => ctx.log.line(line);
	return withOpResult(ctx, () =>
		withJobHost(ctx, async (host) => {
			const config = readPanelConfig();
			switch (action.type) {
				case "checkUpdate":
					return checkForUpdate(host, config);
				case "reload":
					await reloadPanel(host, config, log);
					return true;
				case "update":
					return updatePanel(host, config, log);
				case "setPanelPort":
					log(
						`${action.enabled ? "Publishing" : "Unpublishing"} port ${config.panelPort}`,
					);
					await setPanelPort(host, config, action.enabled);
					await refreshSnapshot(ctx, "panel", () =>
						readPanelStatus(host, config),
					);
					return true;
			}
		}),
	);
};

export const publicIp = async (ctx: JobContext): Promise<JobResult> => {
	specOf(ctx, "infra.publicIp");
	const ip = await withJobHost(ctx, (host) => detectPublicIp(host));
	ctx.log.line(ip ? `Public IP: ${ip}` : "Could not detect the public IP");
	await ctx.convex.mutation(api.infra.agent.reportPublicIp, {
		...leaseArgs(ctx),
		ip,
	});
	return { kind: "none" };
};

// Builds the script without touching the host.
export const defaultSetupScript = async (
	ctx: JobContext,
): Promise<JobResult> => {
	specOf(ctx, "infra.setupScript");
	return withOpResult(ctx, async () => {
		const context = await ctx.convex.query(
			api.infra.agent.getSetupScriptContext,
			leaseArgs(ctx),
		);
		return setupScript({
			...context,
			swarmPublic: process.env.PANARA_CLOUD_SWARM_PUBLIC === "1",
		});
	});
};
