"use client";

import { useEffect, useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { PageTabs } from "@/components/ui-kit/page-tabs";
import { NestedPage } from "@/components/ui-kit/primitives";
import {
	environmentUrl,
	isServiceKind,
	type ServiceRef,
	SOURCE_SECTION,
	serviceNav,
	serviceUrl,
	sourceTabEvents,
	visibleItems,
} from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { useParams, usePathname, useRouter } from "@/lib/router";
import { ServiceProvider, useService, useServiceInfo } from "./service-context";
import { ServiceHeader } from "./service-header";

const SECTION_TITLES: Record<string, string> = {
	deployments: "Deployments",
	logs: "Logs",
	metrics: "Metrics",
	source: "Source",
	backups: "Backups",
	settings: "Settings",
};

export function useServiceRef(): ServiceRef {
	const params = useParams<{
		projectId: string;
		environmentId: string;
		kind: string;
		id: string;
	}>();
	const { projectId, environmentId, kind, id } = params;
	return useMemo(
		() => ({
			projectId,
			environmentId,
			kind: isServiceKind(kind) ? kind : "application",
			id,
		}),
		[projectId, environmentId, kind, id],
	);
}

/** Overview · Source · Deployments (Backups for a database, which has no
    Source) · Logs · Metrics · Settings. Source and Settings carry a dot
    while changes made there wait for a deploy. */
function ServiceTabs() {
	const { service, pending } = useService();
	const permissions = usePermissions();
	const source = serviceUrl(service.ref, SOURCE_SECTION);
	const settings = serviceUrl(service.ref, "settings");
	const sourceEvents = sourceTabEvents(service.kind);
	const events = pending?.events ?? [];
	const waiting = {
		[source]: events.some((event) => sourceEvents.includes(event.type)),
		[settings]: events.some((event) => !sourceEvents.includes(event.type)),
	};
	return (
		<PageTabs
			label="Service sections"
			tabs={visibleItems(serviceNav(service.ref), permissions).map((item) => ({
				title: item.title,
				href: item.url,
				icon: item.icon,
				dot: waiting[item.url] ? "Changes waiting for a deploy" : undefined,
			}))}
		/>
	);
}

function WorkspaceSkeleton() {
	return (
		<div className="flex flex-col gap-6" aria-busy="true">
			<div className="flex items-center gap-3">
				<Skeleton className="size-10 rounded-lg" />
				<Skeleton className="h-7 w-56" />
			</div>
			<Skeleton className="h-10 w-full" />
			<Skeleton className="h-48 w-full" />
		</div>
	);
}

/** Loads the service once for every page of its workspace and renders its
    header and tabs above them. */
export function ServiceWorkspace({ children }: { children: React.ReactNode }) {
	const ref = useServiceRef();
	const router = useRouter();
	const pathname = usePathname();
	const service = useServiceInfo(ref);
	const section = pathname.slice(serviceUrl(ref).length).split("/")[1] ?? "";

	// Deleting the service empties its query before the delete dialog's own
	// navigation runs, so go where that dialog goes: the environment.
	useEffect(() => {
		if (service === null) {
			router.replace(environmentUrl(ref.projectId, ref.environmentId));
		}
	}, [service, router, ref.projectId, ref.environmentId]);

	useEffect(() => {
		if (service?.name) {
			const title = SECTION_TITLES[section];
			document.title = `${title ? `${title} · ` : ""}${service.name} | Panara Cloud`;
		}
	}, [service?.name, section]);

	if (!service) return <WorkspaceSkeleton />;

	return (
		<ServiceProvider service={service}>
			<div className="flex flex-col gap-6 pb-10">
				<div className="flex flex-col gap-5">
					<ServiceHeader />
					<ServiceTabs />
				</div>
				{/* The service is the page's h1; a header inside a tab is an h2. */}
				<NestedPage>{children}</NestedPage>
			</div>
		</ServiceProvider>
	);
}
