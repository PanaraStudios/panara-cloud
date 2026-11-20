import type { QueryCtx } from "../_generated/server";
import { isReservedName } from "./hostPolicy";

// appName becomes the Docker service, stack or container name, so it must be
// unique across every service type on the instance, not just within one table.
export const isAppNameInUse = async (
	ctx: QueryCtx,
	appName: string,
	except?: string,
): Promise<boolean> => {
	// Panara Cloud's own containers, volumes and networks use these names.
	if (isReservedName(appName)) return true;
	const owners = await Promise.all([
		ctx.db
			.query("applications")
			.withIndex("by_appName", (q) => q.eq("appName", appName))
			.first(),
		ctx.db
			.query("applicationPreviews")
			.withIndex("by_appName", (q) => q.eq("appName", appName))
			.first(),
		ctx.db
			.query("compose")
			.withIndex("by_appName", (q) => q.eq("appName", appName))
			.first(),
		ctx.db
			.query("databases")
			.withIndex("by_appName", (q) => q.eq("appName", appName))
			.first(),
	]);
	return owners.some((owner) => owner !== null && owner._id !== except);
};

// The id of the organization's service named appName (the application for
// a preview), if any.
export const serviceIdByAppName = async (
	ctx: QueryCtx,
	organizationId: string,
	appName: string,
): Promise<string | null> => {
	const [application, preview, compose, database] = await Promise.all([
		ctx.db
			.query("applications")
			.withIndex("by_appName", (q) => q.eq("appName", appName))
			.first(),
		ctx.db
			.query("applicationPreviews")
			.withIndex("by_appName", (q) => q.eq("appName", appName))
			.first(),
		ctx.db
			.query("compose")
			.withIndex("by_appName", (q) => q.eq("appName", appName))
			.first(),
		ctx.db
			.query("databases")
			.withIndex("by_appName", (q) => q.eq("appName", appName))
			.first(),
	]);
	if (preview?.organizationId === organizationId) return preview.applicationId;
	const row = [application, compose, database].find(
		(r) => r?.organizationId === organizationId,
	);
	return row?._id ?? null;
};
