import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Role } from "../lib/access";
import { isAppNameInUse } from "../lib/appNames";
import { isTrustedJob } from "../lib/hostPolicy";
import { enqueueJob, type JobSpec } from "../lib/jobs";
import {
	type Access,
	type Action,
	type Resource,
	requireServicePermission,
} from "../lib/permissions";
import { LOCAL_PARTITION } from "../tables/core";

export const COMPOSE_ENV_KIND = "compose.env";
export const MAX_COMPOSE_FILE = 512 * 1024;
export const MAX_SERVICES = 200;
export const DEFAULT_COMPOSE_PATH = "./docker-compose.yml";

export const APP_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const COMPOSE_PATH_REGEX = /^[a-zA-Z0-9._@+][a-zA-Z0-9._@+/-]*$/;
const SUFFIX_REGEX = /^[a-zA-Z0-9_-]{0,32}$/;
// Shell control characters never needed by a docker compose CLI line; they
// would let the command escape `docker <command>` on the host.
const UNSAFE_COMMAND = /[;|`$(){}<>\n\\]/;
const ALPHABET =
	"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export const group = (composeId: Id<"compose">) => `compose:${composeId}`;
export const owner = (composeId: Id<"compose">) => ({
	kind: "compose" as const,
	id: composeId as string,
});
export const partitionOf = (compose: Pick<Doc<"compose">, "serverId">) =>
	compose.serverId ?? LOCAL_PARTITION;

export const randomString = (length: number, alphabet = ALPHABET) =>
	Array.from(
		crypto.getRandomValues(new Uint8Array(length)),
		(byte) => alphabet[byte % alphabet.length],
	).join("");

export const generateRefreshToken = () => randomString(24);

export const generateSuffix = () =>
	randomString(8, "0123456789abcdef").toLowerCase();

// How a deploy names the compose file's volumes (see applyCollisionTransforms
// in the agent): plain `<appName>_<key>`, `<key>-<suffix>` when randomized,
// `<key>-<appName>` for an isolated deployment with its own volumes.
export const volumeNaming = (
	compose: Pick<
		Doc<"compose">,
		| "appName"
		| "randomize"
		| "suffix"
		| "isolatedDeployment"
		| "isolatedDeploymentsVolume"
	>,
): string => {
	if (compose.isolatedDeployment) {
		return compose.isolatedDeploymentsVolume
			? `isolated:${compose.appName}`
			: "";
	}
	return compose.randomize && compose.suffix ? `suffix:${compose.suffix}` : "";
};

export const VOLUME_RENAME =
	"This renames the stack's volumes: the data deployed so far stays in the old volumes, and the next deploy starts with new, empty ones. Confirm to go ahead.";

export const loadCompose = async <R extends Resource>(
	ctx: QueryCtx,
	composeId: Id<"compose">,
	resource: R,
	action: Action<R>,
): Promise<{ compose: Doc<"compose">; access: Access } & Access> => {
	const compose = await ctx.db.get("compose", composeId);
	if (!compose) throw new ConvexError("Compose not found");
	const access = await requireServicePermission(ctx, compose, resource, action);
	return { compose, access, ...access };
};

// A deploy requested by the instance administrator is trusted. One without
// a requester (webhook, git push) runs whatever was last saved, so it is
// trusted only while the last author of the compose configuration is the
// instance administrator: a member who edits the file, settings or env, or
// rotates the webhook token, makes its webhook deploys untrusted until an
// administrator saves it again.
export const composeJobTrusted = async (
	ctx: QueryCtx,
	compose: Doc<"compose">,
	requestedBy: string | undefined,
): Promise<boolean> => {
	if (requestedBy !== undefined) {
		return await isTrustedJob(ctx, compose.organizationId, requestedBy);
	}
	if (compose.configuredBy === undefined) return false;
	return await isTrustedJob(ctx, compose.organizationId, compose.configuredBy);
};

export const isAdmin = (role: Role) => role === "admin" || role === "owner";

// Strips what members may not see; the compose file and env never live on
// this document.
export const publicCompose = (compose: Doc<"compose">, role: Role) => ({
	...compose,
	refreshToken: isAdmin(role) ? compose.refreshToken : null,
});

export const normalizeAppName = (appName: string) => {
	const value = appName.trim().replace(/ /g, "-").toLowerCase();
	if (!APP_NAME_REGEX.test(value)) {
		throw new ConvexError(
			"App name can only contain letters, numbers, dots, underscores and hyphens",
		);
	}
	return value;
};

// App names: `<base>-<random6>`, or `compose-<random>`.
export const buildAppName = (base?: string) => {
	const prefix = base?.trim()
		? base.trim().replace(/ /g, "-").toLowerCase().slice(0, 50)
		: "compose";
	return normalizeAppName(
		`${prefix}-${randomString(6, "abcdefghijklmnopqrstuvwxyz0123456789")}`,
	);
};

export const assertAppNameFree = async (ctx: QueryCtx, appName: string) => {
	if (await isAppNameInUse(ctx, appName)) {
		throw new ConvexError("Service with this 'AppName' already exists");
	}
};

export const validateComposePath = (path: string) => {
	if (
		!path ||
		!COMPOSE_PATH_REGEX.test(path) ||
		path.split("/").includes("..")
	) {
		throw new ConvexError("Invalid compose path");
	}
	return path;
};

export const validateSuffix = (suffix: string) => {
	if (!SUFFIX_REGEX.test(suffix)) {
		throw new ConvexError(
			"Suffix can only contain letters, numbers, underscores and hyphens",
		);
	}
	return suffix;
};

export const validateComposeFile = (content: string) => {
	if (content.length > MAX_COMPOSE_FILE) {
		throw new ConvexError("Compose file is too large");
	}
	return content;
};

// A custom command is what comes after `docker`. The default is shown as
// "docker compose -p …", so a command written the same way loses the word.
const withoutDocker = (command: string) =>
	command.trim().replace(/^docker\s+/, "");

// Allows no shell metacharacters; `&&` chains only into
// further docker compose commands.
export const validateCommand = (command: string) => {
	const value = withoutDocker(command);
	if (!value) return "";
	if (UNSAFE_COMMAND.test(value)) {
		throw new ConvexError(
			"Invalid characters in compose command: shell control characters are not allowed",
		);
	}
	if (value.includes("&")) {
		if (/(?<!&)&(?!&)/.test(value) || value.includes("&&&")) {
			throw new ConvexError(
				"Single '&' is not allowed. Use '&&' for chaining.",
			);
		}
		const chained = value
			.split("&&")
			.slice(1)
			.map((part) => part.trim());
		if (
			!chained.every(
				(part) =>
					part.startsWith("docker compose ") ||
					part.startsWith("docker-compose "),
			)
		) {
			throw new ConvexError(
				"Chained commands must strictly start with 'docker compose '",
			);
		}
	}
	return value;
};

const shellQuote = (value: string) =>
	/^[A-Za-z0-9_./@%+=:,-]+$/.test(value)
		? value
		: `'${value.replace(/'/g, `'\\''`)}'`;

// path.posix.join(dirname(path), ".env") for relative compose paths.
const envFileFor = (path: string) => {
	const dir = path
		.replace(/^(\.\/)+/, "")
		.split("/")
		.slice(0, -1)
		.filter((part) => part && part !== ".")
		.join("/");
	return dir ? `${dir}/.env` : ".env";
};

// What the agent runs (apps/agent/src/compose/command.ts builds the same
// line), shown as the default command in the UI.
export const defaultCommand = (compose: Doc<"compose">, hasMounts: boolean) => {
	if (compose.command) return `docker ${withoutDocker(compose.command)}`;
	const path =
		compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath;
	if (compose.composeType === "stack") {
		return `docker stack deploy -c ${shellQuote(path)} ${shellQuote(compose.appName)} --prune --with-registry-auth`;
	}
	const codeDir = `/etc/panara-cloud/compose/${compose.appName}/code`;
	const projectDirectory = hasMounts
		? `--project-directory ${shellQuote(codeDir)} `
		: "";
	const envFile = compose.createEnvFile
		? `--env-file ${shellQuote(envFileFor(compose.composePath))} `
		: "";
	const pull = compose.pullImages ? " --pull always" : "";
	return `docker compose -p ${shellQuote(compose.appName)} ${projectDirectory}${envFile}-f ${shellQuote(path)} up -d --build --remove-orphans${pull}`;
};

export const enqueueComposeJob = (
	ctx: MutationCtx,
	compose: Doc<"compose">,
	spec: JobSpec,
	options: {
		requestedBy?: string;
		usesBuildSlot?: boolean;
		idempotent?: boolean;
		maxAttempts?: number;
	} = {},
) =>
	enqueueJob(ctx, {
		organizationId: compose.organizationId,
		partition: partitionOf(compose),
		group: group(compose._id),
		spec,
		idempotent: options.idempotent ?? false,
		usesBuildSlot: options.usesBuildSlot ?? false,
		maxAttempts: options.maxAttempts,
		requestedBy: options.requestedBy,
	});

// Queues a deploy (clone + build + up) or redeploy (reuse the code on the
// host) and records it in `deployments`.
export const enqueueDeploy = async (
	ctx: MutationCtx,
	compose: Doc<"compose">,
	input: {
		kind: "compose.deploy" | "compose.redeploy";
		title?: string;
		description?: string;
		freshVolumes?: boolean;
		commit?: { sha: string; message?: string };
		requestedBy?: string;
	},
): Promise<{ jobId: Id<"jobs">; deploymentId: Id<"deployments"> }> => {
	const jobId = await enqueueComposeJob(
		ctx,
		compose,
		{
			kind: input.kind,
			composeId: compose._id,
			...(input.freshVolumes ? { freshVolumes: true } : {}),
			...((await composeJobTrusted(ctx, compose, input.requestedBy))
				? { trusted: true }
				: {}),
		},
		{ requestedBy: input.requestedBy, usesBuildSlot: true },
	);
	const deploymentId = await ctx.db.insert("deployments", {
		organizationId: compose.organizationId,
		jobId,
		target: owner(compose._id),
		title:
			input.title?.trim() ||
			(input.kind === "compose.deploy"
				? "Manual deployment"
				: "Rebuild deployment"),
		description: input.description || undefined,
		commit: input.commit,
	});
	return { jobId, deploymentId };
};

export const cancelQueuedJobs = async (
	ctx: MutationCtx,
	composeId: Id<"compose">,
) => {
	const queued = await ctx.db
		.query("jobs")
		.withIndex("by_group_and_status", (q) =>
			q.eq("group", group(composeId)).eq("status", "queued"),
		)
		.take(100);
	const now = Date.now();
	for (const job of queued) {
		await ctx.db.patch("jobs", job._id, {
			status: "cancelled",
			cancelRequested: true,
			finishedAt: now,
		});
	}
	return queued.length;
};
