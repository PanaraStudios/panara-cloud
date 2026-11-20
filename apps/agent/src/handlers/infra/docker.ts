import { api } from "@panara-cloud/backend/api";
import {
	containerAction,
	createNetwork,
	getClusterJoinInfo,
	getDiskUsage,
	listContainers,
	listContainersByApp,
	listImages,
	listNetworks,
	listSwarmNodes,
	listVolumes,
	removeSwarmNode,
	runCleanup,
} from "../../infra/docker";
import { getServerHealth } from "../../infra/health";
import {
	readTraefikState,
	restartTraefik,
} from "../../infra/traefik/container";
import { type JobContext, JobFailure, type JobResult } from "../types";
import {
	errorMessage,
	leaseArgs,
	refreshSnapshot,
	reportOpResult,
	specOf,
	withJobHost,
} from "./common";

const CONTAINER_ACTIONS = {
	containerStart: "start",
	containerStop: "stop",
	containerRestart: "restart",
	containerKill: "kill",
	containerRemove: "remove",
} as const;

export const dockerAction = async (ctx: JobContext): Promise<JobResult> => {
	const { action } = specOf(ctx, "infra.dockerAction");
	ctx.log.line(`Running ${action.type}`);
	await withJobHost(ctx, async (host) => {
		const docker = host.docker();
		const op = async (read: () => Promise<unknown>) => {
			try {
				await reportOpResult(ctx, await read());
			} catch (error) {
				await reportOpResult(ctx, undefined, errorMessage(error)).catch(
					() => {},
				);
				throw error;
			}
		};
		switch (action.type) {
			case "containerStart":
			case "containerStop":
			case "containerRestart":
			case "containerKill":
			case "containerRemove":
				await containerAction(
					host,
					action.containerId,
					CONTAINER_ACTIONS[action.type],
				);
				await refreshSnapshot(ctx, "containers", () => listContainers(host));
				return;
			case "containerInspect":
				return op(() => docker.getContainer(action.containerId).inspect());
			case "imageRemove":
				await docker.getImage(action.imageRef).remove({ force: action.force });
				await refreshSnapshot(ctx, "images", () => listImages(host));
				return;
			case "imageInspect":
				return op(() => docker.getImage(action.imageRef).inspect());
			case "volumeRemove":
				await docker.getVolume(action.name).remove();
				await refreshSnapshot(ctx, "volumes", () => listVolumes(host));
				return;
			case "volumeInspect":
				return op(() => docker.getVolume(action.name).inspect());
			case "networkCreate": {
				const network = await ctx.convex.query(
					api.infra.agent.getNetwork,
					leaseArgs(ctx),
				);
				if (!network) {
					ctx.log.line("Network was deleted before it was created");
					return;
				}
				try {
					const dockerId = await createNetwork(host, network);
					await ctx.convex.mutation(api.infra.agent.reportNetwork, {
						...leaseArgs(ctx),
						dockerId,
					});
				} catch (error) {
					await ctx.convex.mutation(api.infra.agent.reportNetwork, {
						...leaseArgs(ctx),
						error: errorMessage(error),
					});
					throw error;
				}
				await refreshSnapshot(ctx, "networks", () => listNetworks(host));
				return;
			}
			case "networkRemove":
				await docker.getNetwork(action.name).remove();
				await refreshSnapshot(ctx, "networks", () => listNetworks(host));
				return;
			case "networkInspect":
				return op(() => docker.getNetwork(action.name).inspect());
			case "nodeInspect":
				return op(() => docker.getNode(action.nodeId).inspect());
			case "nodeRemove":
				await removeSwarmNode(host, action.nodeId);
				await refreshSnapshot(ctx, "swarmNodes", () => listSwarmNodes(host));
				return;
			case "containerList":
				return op(() =>
					listContainersByApp(
						host,
						action.appName,
						action.appType,
						action.organizationId,
					),
				);
			case "serverHealth":
				return op(() => getServerHealth(host, action.sinceHours));
			case "clusterJoinInfo":
				return op(() => getClusterJoinInfo(host));
			case "traefikRestart":
				await restartTraefik(host);
				await refreshSnapshot(ctx, "traefik", () => readTraefikState(host));
				return;
		}
	});
	return { kind: "none" };
};

export const dockerCleanup = async (ctx: JobContext): Promise<JobResult> => {
	const { scope } = specOf(ctx, "infra.dockerCleanup");
	ctx.log.line(`Docker cleanup (${scope})`);
	const { failed } = await withJobHost(ctx, async (host) => {
		const result = await runCleanup(
			host,
			scope,
			(text) => ctx.log.append(text),
			ctx.signal,
		);
		await refreshSnapshot(ctx, "diskUsage", () => getDiskUsage(host));
		return result;
	});
	if (failed > 0) throw new JobFailure(`${failed} cleanup step(s) failed`);
	return { kind: "none" };
};
