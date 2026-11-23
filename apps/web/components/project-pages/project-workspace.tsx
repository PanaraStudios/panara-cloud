"use client";

import { api } from "@panara-cloud/backend/api";
import { useConvexAuth, useQuery } from "convex/react";
import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageTabs } from "@/components/ui-kit/page-tabs";
import { NestedPage, PageHeader } from "@/components/ui-kit/primitives";
import {
	environmentUrl,
	projectNav,
	projectUrl,
	visibleItems,
} from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";

const count = (services: number) =>
	services === 1 ? "1 service" : `${services} services`;

/** A project's header and tabs (Services · Shared variables · Settings) above
    those three pages. Its other pages (the new-service flow, a service) are
    pages of their own and render as they are. */
export function ProjectWorkspace({ children }: { children: React.ReactNode }) {
	const { projectId, environmentId } = useParams<{
		projectId: string;
		environmentId?: string;
	}>();
	const pathname = usePathname();
	const permissions = usePermissions();
	const { active } = useOrganization();
	const { isAuthenticated } = useConvexAuth();
	const projects = useQuery(
		api.projects.all,
		isAuthenticated ? { organizationId: active.id } : "skip",
	);
	const rest = pathname.slice(projectUrl(projectId).length);
	const tabbed =
		rest === "/settings" || /^\/environment\/[^/]+(\/variables)?$/.test(rest);
	if (!tabbed) return children;

	const project = projects?.find((item) => item.projectId === projectId);
	// A project that doesn't exist: the page says so.
	if (projects && !project) return children;
	const environment =
		project?.environments.find(
			(item) => item.environmentId === environmentId,
		) ??
		project?.environments.find((item) => item.isDefault) ??
		project?.environments[0];
	const services = environmentId
		? (environment?.services.length ?? 0)
		: (project?.environments.flatMap((item) => item.services).length ?? 0);

	return (
		<div className="flex w-full flex-1 flex-col gap-6">
			<div className="flex flex-col gap-5">
				{project ? (
					<PageHeader
						title={project.name}
						description={[project.description, count(services)]
							.filter(Boolean)
							.join(" · ")}
					>
						{permissions.service.create && environment ? (
							<Button
								nativeButton={false}
								render={
									<Link
										href={`${environmentUrl(projectId, environment.environmentId)}/new`}
									/>
								}
							>
								<PlusIcon data-icon="inline-start" />
								New service
							</Button>
						) : null}
					</PageHeader>
				) : (
					<div className="flex flex-col gap-2" aria-busy="true">
						<Skeleton className="h-7 w-48" />
						<Skeleton className="h-4 w-32" />
					</div>
				)}
				{environment ? (
					<PageTabs
						label="Project sections"
						tabs={visibleItems(
							projectNav(projectId, environment.environmentId),
							permissions,
						).map((item) => ({
							title: item.title,
							href: item.url,
							icon: item.icon,
						}))}
					/>
				) : (
					<div className="h-10 border-border border-b" />
				)}
			</div>
			<NestedPage>{children}</NestedPage>
		</div>
	);
}
