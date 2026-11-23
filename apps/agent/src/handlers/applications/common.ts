import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import type { FunctionReturnType } from "convex/server";
import { connectHost, withHost } from "../../host";
import type { Host } from "../../host/types";
import { envObject, prepareEnvironmentVariables } from "../../lib/env";
import type { Claim, JobContext, JobTarget } from "../types";
import { JobFailure } from "../types";

type Spec = Claim["spec"];
export type SpecOf<K extends Spec["kind"]> = Extract<Spec, { kind: K }>;

export type DeployContext = NonNullable<
	FunctionReturnType<typeof api.applications.agent.getDeployContext>
>;

export const leaseArgs = (ctx: JobContext) => ({
	jobId: ctx.claim.jobId,
	leaseId: ctx.claim.leaseId,
});

export const specOf = <K extends Spec["kind"]>(
	ctx: JobContext,
	...kinds: K[]
): SpecOf<K> => {
	if (!kinds.includes(ctx.claim.spec.kind as K)) {
		throw new JobFailure(`Expected a ${kinds.join("/")} job`);
	}
	return ctx.claim.spec as SpecOf<K>;
};

export const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const VAULT_REF = "${{vault.";

// Substitutes vault references first, then project/environment/self
// references.
export const resolveEnv = async (
	ctx: JobContext,
	scope: { projectId: Id<"projects">; environmentId: Id<"environments"> },
	raw: {
		env: string;
		buildArgs?: string;
		buildSecrets?: string;
		projectEnv: string;
		environmentEnv: string;
	},
) => {
	let values = [
		raw.env,
		raw.buildArgs ?? "",
		raw.buildSecrets ?? "",
		raw.projectEnv,
		raw.environmentEnv,
	];
	if (values.some((value) => value.includes(VAULT_REF))) {
		values = await ctx.convex.action(api.platform.vaultActions.resolveForJob, {
			...leaseArgs(ctx),
			projectId: scope.projectId,
			environmentId: scope.environmentId,
			values,
		});
	}
	const [
		env = "",
		buildArgs = "",
		buildSecrets = "",
		projectEnv = "",
		environmentEnv = "",
	] = values;
	return {
		env: prepareEnvironmentVariables(env, projectEnv, environmentEnv),
		buildArgs: prepareEnvironmentVariables(
			buildArgs,
			projectEnv,
			environmentEnv,
		),
		buildSecrets: envObject(
			prepareEnvironmentVariables(buildSecrets, projectEnv, environmentEnv),
		),
	};
};

// Runs `fn` with the job's host (the build server for builds) and the
// deploy server, sharing one connection when they're the same machine.
export const withBuildAndDeployHosts = async <T>(
	ctx: JobContext,
	deployTarget: JobTarget,
	sameHost: boolean,
	fn: (hosts: { build: Host; deploy: Host }) => Promise<T>,
): Promise<T> =>
	withHost(await ctx.getTarget(), ctx.signal, async (build) => {
		if (sameHost) return await fn({ build, deploy: build });
		const deploy = await connectHost(deployTarget, ctx.signal);
		try {
			return await fn({ build, deploy });
		} finally {
			deploy.close();
		}
	});
