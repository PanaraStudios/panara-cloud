import { api } from "@panara-cloud/backend/api";
import type { Host } from "../../host/types";
import {
	getBuildCache,
	getDiskUsage,
	listContainers,
	listImages,
	listNetworks,
	listSwarmNodes,
	listSwarmServices,
	listVolumes,
} from "../../infra/docker";
import { checkGpuStatus } from "../../infra/gpu";
import { getServerHealth } from "../../infra/health";
import { readPanelConfig, readPanelStatus } from "../../infra/panel";
import {
	getExposedPorts,
	getFail2banStatus,
	getPendingUpdates,
	getServerActivity,
	getSshSecurity,
	panelKeyFingerprint,
	parseAudit,
} from "../../infra/security";
import { auditScript, validateServer } from "../../infra/setup";
import { runScript } from "../../infra/shell";
import { readTraefikState } from "../../infra/traefik";
import { readVectorServices } from "../../platform/vector";
import type { JobContext, JobResult } from "../types";
import {
	errorMessage,
	leaseArgs,
	reportSnapshot,
	type SnapshotKind,
	specOf,
	withJobHost,
} from "./common";

const securityContext = (ctx: JobContext) =>
	ctx.convex.query(api.infra.agent.getSecurityContext, leaseArgs(ctx));

// Reads one kind of live host state. Shared with handlers that refresh a
// snapshot after changing the host.
export const readSnapshot = async (
	ctx: JobContext,
	host: Host,
	kind: SnapshotKind,
): Promise<unknown> => {
	switch (kind) {
		case "validate":
			return validateServer(host);
		case "audit":
			return parseAudit(await runScript(host, auditScript));
		case "containers":
			return listContainers(host);
		case "images":
			return listImages(host);
		case "volumes":
			return listVolumes(host);
		case "networks":
			return listNetworks(host);
		case "diskUsage":
			return getDiskUsage(host);
		case "buildCache":
			return getBuildCache(host);
		case "swarmNodes":
			return listSwarmNodes(host);
		case "swarmServices":
			return listSwarmServices(host);
		case "health":
			return getServerHealth(host);
		case "traefik":
			return readTraefikState(host);
		case "fail2ban":
			return getFail2banStatus(host, (await securityContext(ctx)).panelIps);
		case "exposedPorts":
			return getExposedPorts(host);
		case "pendingUpdates":
			return getPendingUpdates(host);
		case "sshSecurity": {
			const context = await securityContext(ctx);
			const target = await ctx.getTarget();
			return getSshSecurity(host, {
				username: context.username,
				port: context.port,
				panelFingerprint: panelKeyFingerprint({
					privateKey: target.type === "ssh" ? target.privateKey : null,
					publicKey: context.panelPublicKey,
				}),
			});
		}
		case "activity":
			return getServerActivity(host, (await securityContext(ctx)).panelIps);
		case "gpu":
			return checkGpuStatus(host);
		case "panel":
			return readPanelStatus(host, readPanelConfig());
		case "vector":
			return readVectorServices(host);
	}
};

export const inspect = async (ctx: JobContext): Promise<JobResult> => {
	const { what } = specOf(ctx, "infra.inspect");
	ctx.log.line(`Reading ${what}`);
	try {
		const data = await withJobHost(ctx, (host) =>
			readSnapshot(ctx, host, what),
		);
		await reportSnapshot(ctx, what, data);
	} catch (error) {
		await reportSnapshot(ctx, what, null, errorMessage(error)).catch(() => {});
		throw error;
	}
	return { kind: "none" };
};
