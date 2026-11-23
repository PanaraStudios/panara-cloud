import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import { serviceIdByAppName } from "../lib/appNames";
import {
	requireServicePermission,
	resolvePermissions,
} from "../lib/permissions";

// Backup folders start with the owning service's app name ("<appName>/" or
// "<appName>_<serviceName>/"): a scoped member reaches only folders of
// services they may read backups of.
export const requireOwnBackupFolder = async (
	ctx: QueryCtx,
	organizationId: string,
	path: string,
) => {
	const folder = path.split("/")[0] ?? "";
	const candidates = [folder];
	for (let i = folder.indexOf("_"); i > 0; i = folder.indexOf("_", i + 1)) {
		candidates.push(folder.slice(0, i));
	}
	for (const appName of candidates) {
		if (!appName) continue;
		const serviceId = await serviceIdByAppName(ctx, organizationId, appName);
		if (!serviceId) continue;
		await requireServicePermission(
			ctx,
			{ _id: serviceId, organizationId },
			"backup",
			"read",
		);
		return;
	}
	throw new ConvexError(
		"Open the backup folder of a service you have access to",
	);
};

// A backup file to restore: scoped members restore only from the backup
// folders of services they can reach, never another service's data.
export const assertBackupFileAccess = async (
	ctx: QueryCtx,
	organizationId: string,
	file: string,
) => {
	const access = await resolvePermissions(ctx, organizationId);
	if (access.scope) await requireOwnBackupFolder(ctx, organizationId, file);
};
