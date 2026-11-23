import { api } from "@panara-cloud/backend/api";
import {
	removeCertificate,
	removeServiceRouting,
	writeCertificate,
	writeServiceRouting,
} from "../../infra/traefik";
import {
	listTraefikFiles,
	readTraefikFile,
	writeTraefikFile,
} from "../../infra/traefik/files";
import { type JobContext, JobFailure, type JobResult } from "../types";
import {
	errorMessage,
	leaseArgs,
	reportOpResult,
	specOf,
	withJobHost,
} from "./common";

export const routingSync = async (ctx: JobContext): Promise<JobResult> => {
	const { owner } = specOf(ctx, "infra.routingSync");
	const snapshot = await ctx.convex.query(
		api.infra.agent.getRoutingSnapshot,
		leaseArgs(ctx),
	);
	if (!snapshot) {
		ctx.log.line(
			`${owner.kind} ${owner.id} no longer exists; nothing to route`,
		);
		return { kind: "none" };
	}
	if (owner.kind === "compose") {
		ctx.log.line("Compose domains are applied as labels on the next deploy");
		return { kind: "none" };
	}
	const result = await withJobHost(ctx, (host) =>
		writeServiceRouting(host, snapshot),
	);
	ctx.log.line(
		result.removed
			? `No enabled domains; removed ${result.path}`
			: `Wrote ${result.routers} router(s) to ${result.path} ✅`,
	);
	return { kind: "none" };
};

export const routingRemove = async (ctx: JobContext): Promise<JobResult> => {
	const { appName } = specOf(ctx, "infra.routingRemove");
	await withJobHost(ctx, (host) => removeServiceRouting(host, appName));
	ctx.log.line(`Removed routing for ${appName}`);
	return { kind: "none" };
};

export const certificateSync = async (ctx: JobContext): Promise<JobResult> => {
	specOf(ctx, "infra.certificateSync");
	const certificate = await ctx.convex.query(
		api.infra.agent.getCertificate,
		leaseArgs(ctx),
	);
	if (!certificate) {
		ctx.log.line("Certificate was deleted; nothing to write");
		return { kind: "none" };
	}
	await withJobHost(ctx, (host) => writeCertificate(host, certificate));
	ctx.log.line(`Certificate ${certificate.certificatePath} written ✅`);
	return { kind: "none" };
};

export const certificateRemove = async (
	ctx: JobContext,
): Promise<JobResult> => {
	const { certificatePath } = specOf(ctx, "infra.certificateRemove");
	await withJobHost(ctx, (host) => removeCertificate(host, certificatePath));
	ctx.log.line(`Certificate ${certificatePath} removed`);
	return { kind: "none" };
};

export const traefikFiles = async (ctx: JobContext): Promise<JobResult> => {
	const { op, path } = specOf(ctx, "infra.traefikFiles");
	try {
		await withJobHost(ctx, async (host) => {
			if (op === "list") {
				await reportOpResult(ctx, await listTraefikFiles(host));
				return;
			}
			if (!path) throw new JobFailure("A path is required");
			if (op === "read") {
				await reportOpResult(ctx, await readTraefikFile(host, path));
				return;
			}
			const content = await ctx.convex.query(
				api.infra.agent.getOpInput,
				leaseArgs(ctx),
			);
			if (content === null) throw new JobFailure("Nothing to write");
			await writeTraefikFile(host, path, content);
			ctx.log.line(`Wrote ${path}`);
			await reportOpResult(ctx, { written: path });
		});
	} catch (error) {
		await reportOpResult(ctx, undefined, errorMessage(error)).catch(() => {});
		throw error;
	}
	return { kind: "none" };
};
