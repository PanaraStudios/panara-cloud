"use client";

import { ServerIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { PageTabs } from "@/components/ui-kit/page-tabs";
import { NestedPage, NotFoundState } from "@/components/ui-kit/primitives";
import { serverNav, visibleItems } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { ServerHeader, ServerHeaderSlots } from "./overview-header";
import { needsSetup, serverStatus, useServerRef } from "./use-server";

/** Loads the server for every page under `/servers/[serverId]` and renders
    its header and tabs above them. A server that isn't set up yet has only
    Overview, Terminal and Settings. */
export function ServerWorkspace({ children }: { children: React.ReactNode }) {
	const ref = useServerRef();
	const permissions = usePermissions();
	if (ref.found === undefined) {
		return (
			<div className="flex flex-col gap-6" aria-busy="true">
				<Skeleton className="h-7 w-56" />
				<Skeleton className="h-10 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}
	if (!ref.found)
		return (
			<NotFoundState icon={ServerIcon} noun="server" backHref="/servers" />
		);
	const setUp =
		ref.isLocal || !ref.server || !needsSetup(serverStatus(ref.server));
	return (
		<ServerHeaderSlots key={ref.routeId}>
			<div className="flex w-full flex-1 flex-col gap-6">
				<div className="flex flex-col gap-5">
					<ServerHeader refInfo={ref} />
					<PageTabs
						label="Server sections"
						tabs={visibleItems(
							serverNav(ref.routeId, { setUp }),
							permissions,
						).map((item) => ({ title: item.title, href: item.url }))}
					/>
				</div>
				{/* The server is the page's h1; a header inside a tab is an h2. */}
				<NestedPage>{children}</NestedPage>
			</div>
		</ServerHeaderSlots>
	);
}
