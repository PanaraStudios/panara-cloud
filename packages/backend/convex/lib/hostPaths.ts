// Shared by the backend (bind mount validation) and the agent (deploy-time
// bind mount checks), so keep this file free of Convex imports.

export const PROTECTED_HOST_PATHS: readonly string[] = [
	"/etc",
	"/root",
	"/var/lib/docker",
	"/var/run/docker.sock",
	"/run/docker.sock",
	"/proc",
	"/sys",
	"/dev",
	"/boot",
];

export type NormalizedHostPath =
	| { ok: true; path: string }
	| { ok: false; error: string };

export const normalizeHostPath = (hostPath: string): NormalizedHostPath => {
	if (!hostPath.startsWith("/")) {
		return { ok: false, error: "Host path must be absolute" };
	}
	const segments = hostPath.split("/").filter((s) => s !== "" && s !== ".");
	if (segments.includes("..")) {
		return { ok: false, error: "Host path can't contain '..'" };
	}
	return { ok: true, path: `/${segments.join("/")}` };
};

export const isWithin = (path: string, dir: string) =>
	path === dir || path.startsWith(`${dir}/`);

// Takes a normalized path. A bind mount exposes everything below its host
// path, so a parent of a protected path (such as / or /var/run) is as
// dangerous as the path itself.
export const isProtectedNormalizedPath = (path: string) =>
	path === "/" ||
	PROTECTED_HOST_PATHS.some((p) => isWithin(path, p) || isWithin(p, path));
