import { api } from "@panara-cloud/backend/api";
import { withHost } from "../../host";
import type { Host } from "../../host/types";
import { type Claim, type JobContext, JobFailure } from "../types";

type Spec = Claim["spec"];
export type SpecOf<K extends Spec["kind"]> = Extract<Spec, { kind: K }>;
export type SnapshotKind = SpecOf<"infra.inspect">["what"];

export const leaseArgs = (ctx: JobContext) => ({
	jobId: ctx.claim.jobId,
	leaseId: ctx.claim.leaseId,
});

export const specOf = <K extends Spec["kind"]>(
	ctx: JobContext,
	kind: K,
): SpecOf<K> => {
	if (ctx.claim.spec.kind !== kind) {
		throw new JobFailure(`Expected a ${kind} job`);
	}
	return ctx.claim.spec as SpecOf<K>;
};

export const withJobHost = async <T>(
	ctx: JobContext,
	fn: (host: Host) => Promise<T>,
): Promise<T> => withHost(await ctx.getTarget(), ctx.signal, fn);

export const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

export const reportSnapshot = (
	ctx: JobContext,
	kind: SnapshotKind,
	data: unknown,
	error?: string,
) =>
	ctx.convex.mutation(api.infra.agent.reportSnapshot, {
		...leaseArgs(ctx),
		kind,
		data: JSON.stringify(data ?? null),
		error,
	});

export const reportOpResult = (
	ctx: JobContext,
	result: unknown,
	error?: string,
) =>
	ctx.convex.mutation(api.infra.agent.reportOpResult, {
		...leaseArgs(ctx),
		result: result === undefined ? undefined : JSON.stringify(result),
		error,
	});

// Refreshes a snapshot after a change without failing the change itself.
export const refreshSnapshot = async (
	ctx: JobContext,
	kind: SnapshotKind,
	read: () => Promise<unknown>,
) => {
	try {
		await reportSnapshot(ctx, kind, await read());
	} catch (error) {
		ctx.log.line(`Could not refresh ${kind}: ${errorMessage(error)}`);
	}
};

// dotenv-style text to Docker's KEY=VALUE list; comments and blanks dropped.
export const parseEnv = (env: string): string[] =>
	env
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#") && line.includes("="));
