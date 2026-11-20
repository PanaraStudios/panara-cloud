import {
	isProtectedNormalizedPath,
	isWithin,
	normalizeHostPath,
} from "../../../../packages/backend/convex/lib/hostPaths";
import type { Host } from "../host/types";
import { paths } from "./constants";
import { quote } from "./shell";
import type { Mount } from "./swarm";

// Application and database bind mounts saved before the backend validated
// them (or edited around it) are rechecked here. Jobs the backend marks
// `trusted` (instance admin, root organization) skip the check; others may
// bind only inside the service's own folder on the Panara Cloud server, and
// anything but system paths on their organization's servers.

export type BindScope = { appName: string; panelHost: boolean };

export const serviceDir = (appName: string) =>
	`${paths.applications}/${appName}`;

const ADVICE =
	"use a volume instead, or ask the instance administrator to deploy it";

export const bindMountProblem = (
	hostPath: string,
	scope: BindScope,
): string | null => {
	const normalized = normalizeHostPath(hostPath);
	if (!normalized.ok) {
		return `Bind mount ${hostPath} is not allowed: ${normalized.error}`;
	}
	const { path } = normalized;
	if (isWithin(path, serviceDir(scope.appName))) return null;
	if (scope.panelHost) {
		return `Bind mount ${path} is not allowed: on the Panara Cloud server only the instance administrator can mount host paths outside ${serviceDir(scope.appName)}; ${ADVICE}`;
	}
	if (isProtectedNormalizedPath(path)) {
		return `Bind mount ${path} is not allowed: it exposes the host system; ${ADVICE}`;
	}
	return null;
};

// Docker follows symlinks in a bind source, so a link planted by a container
// inside the service's folder must not lead elsewhere. Unresolvable paths
// keep their own name (Docker refuses a missing bind source anyway).
const resolveOnHost = async (host: Host, hostPaths: string[]) => {
	const script = hostPaths
		.map(
			(path) =>
				`printf '%s\\0' "$(realpath -m -- ${quote(path)} 2>/dev/null || readlink -f -- ${quote(path)} 2>/dev/null)"`,
		)
		.join("\n");
	const { output } = await host.exec(script);
	const resolved = output.split("\0");
	return hostPaths.map((path, i) => resolved[i] || path);
};

export const assertBindPathsAllowed = async (
	host: Host,
	appName: string,
	hostPaths: string[],
	trusted: boolean,
) => {
	if (trusted || hostPaths.length === 0) return;
	const scope = { appName, panelHost: host.kind === "local" };
	for (const path of hostPaths) {
		const problem = bindMountProblem(path, scope);
		if (problem) throw new Error(problem);
	}
	const real = await resolveOnHost(host, hostPaths);
	real.forEach((target, i) => {
		const problem = bindMountProblem(target, scope);
		if (problem) {
			throw new Error(
				`Bind mount ${hostPaths[i]} points to ${target} through a symlink. ${problem}`,
			);
		}
	});
};

export const assertBindMountsAllowed = (
	host: Host,
	appName: string,
	mounts: Mount[],
	trusted: boolean,
) =>
	assertBindPathsAllowed(
		host,
		appName,
		mounts.flatMap((mount) => (mount.type === "bind" ? [mount.hostPath] : [])),
		trusted,
	);

// start / reload only scale the existing Swarm service, so its current bind
// mounts are what would run.
export const assertServiceBindsAllowed = async (
	host: Host,
	appName: string,
	trusted: boolean,
) => {
	if (trusted) return;
	const inspect = await host
		.docker()
		.getService(appName)
		.inspect()
		.catch((error: { statusCode?: number }) => {
			if (error.statusCode === 404) return null;
			throw error;
		});
	const mounts: { Type?: string; Source?: string }[] =
		inspect?.Spec?.TaskTemplate?.ContainerSpec?.Mounts ?? [];
	await assertBindPathsAllowed(
		host,
		appName,
		mounts.flatMap((mount) =>
			mount.Type === "bind" && mount.Source ? [mount.Source] : [],
		),
		trusted,
	);
};

export const isTrustedSpec = (spec: unknown) =>
	(spec as { trusted?: unknown }).trusted === true;
