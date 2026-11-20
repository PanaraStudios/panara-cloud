import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import { getRootOrganizationId, requireInstanceAdmin } from "../infra/access";
import {
	isProtectedNormalizedPath,
	normalizeHostPath as normalizeSharedHostPath,
} from "./hostPaths";
import { requirePermission } from "./permissions";

// Panara Cloud's own Docker resources (Convex data, Traefik, the agent, ...)
// are all named panara-cloud-*; services must never be able to claim or
// mount one of them.
export const isReservedName = (name: string) =>
	/^panara[-_.]?cloud/i.test(name.trim());

// Host-level powers belong to the instance administrator acting for a
// service of the root organization.
export const isTrustedRequester = async (
	ctx: QueryCtx,
	organizationId: string,
): Promise<boolean> => {
	try {
		const { organizationId: root } = await requireInstanceAdmin(ctx);
		return root === organizationId;
	} catch {
		return false;
	}
};

// Jobs that apply host-level settings (compose host features, application
// and database bind mounts) honour them only when the service is in the root
// organization and the job was requested by one of its owners or admins.
// Jobs without a requester (git webhooks, follow-up jobs) of root
// organization services keep them, so the instance admin's auto-deploys
// behave as before.
export const isTrustedJob = async (
	ctx: QueryCtx,
	organizationId: string,
	requestedBy: string | undefined,
): Promise<boolean> => {
	const root = await getRootOrganizationId(ctx);
	if (!root || organizationId !== root) return false;
	if (requestedBy === undefined) return true;
	const membership = await ctx.db
		.query("memberships")
		.withIndex("by_organizationId_and_userId", (q) =>
			q.eq("organizationId", root).eq("userId", requestedBy),
		)
		.unique();
	return (
		!!membership &&
		!membership.deactivated &&
		(membership.role === "admin" || membership.role === "owner")
	);
};

export const normalizeHostPath = (hostPath: string): string => {
	const normalized = normalizeSharedHostPath(hostPath);
	if (!normalized.ok) throw new ConvexError(normalized.error);
	return normalized.path;
};

export const isProtectedHostPath = (hostPath: string) =>
	isProtectedNormalizedPath(normalizeHostPath(hostPath));

// Bind mounts reach the host's filesystem: on the panel host only the
// instance administrator may add them, on an organization's server only
// those allowed to open its terminal, and system paths stay off limits for
// everyone but the instance administrator.
export const assertBindMountAllowed = async (
	ctx: QueryCtx,
	organizationId: string,
	serverId: string | undefined,
	hostPath: string,
) => {
	if (await isTrustedRequester(ctx, organizationId)) return;
	if (!serverId) {
		throw new ConvexError(
			"Only the instance administrator can add bind mounts on the Panara Cloud server; use a volume instead",
		);
	}
	await requirePermission(ctx, organizationId, "server", "terminal").catch(
		() => {
			throw new ConvexError(
				"Only organization owners and admins can add bind mounts; use a volume instead",
			);
		},
	);
	if (isProtectedHostPath(hostPath)) {
		throw new ConvexError(
			`Bind mounts of ${normalizeHostPath(hostPath)} are not allowed: it exposes the host system`,
		);
	}
};
