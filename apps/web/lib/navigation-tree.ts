"use client";

import { api } from "@panara-cloud/backend/api";
import { useConvexAuth, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useOrganization } from "@/lib/organization";
import { serviceStatusWord } from "@/lib/service-actions";

export type NavigationTree = FunctionReturnType<
	typeof api.projects.navigationTree
>;
export type TreeProject = NavigationTree["projects"][number];
export type TreeEnvironment = TreeProject["environments"][number];
export type TreeService = TreeEnvironment["services"][number];
export type TreeServer = NonNullable<NavigationTree["servers"]>[number];

/** What the shell knows about the organization: its projects with their
    environments and services, and its servers, each as little as a row
    shows. The sidebar and the breadcrumb read the same subscription. */
export function useNavigationTree(enabled = true) {
	const { active } = useOrganization();
	const { isAuthenticated } = useConvexAuth();
	return useQuery(
		api.projects.navigationTree,
		enabled && isAuthenticated ? { organizationId: active.id } : "skip",
	);
}

/** A service's status as every other screen words it. */
export const treeStatus = (service: TreeService) =>
	serviceStatusWord(service.status, service.runtime ?? undefined);

export const defaultEnvironment = (project: TreeProject | undefined) =>
	project?.environments.find((environment) => environment.isDefault) ??
	project?.environments[0];
