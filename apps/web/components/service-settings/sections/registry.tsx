"use client";

import { ShowClusterSettings } from "@/components/dashboard/application/advanced/cluster/show-cluster-settings";
import { AddCommand } from "@/components/dashboard/application/advanced/general/add-command";
import { ShowImport } from "@/components/dashboard/application/advanced/import/show-import";
import { ShowBuildServer } from "@/components/dashboard/application/advanced/show-build-server";
import { ShowBuildChooseForm } from "@/components/dashboard/application/build/show";
import { FormSection } from "@/components/dashboard/application/form-kit";
import { ShowProviderForm } from "@/components/dashboard/application/general/generic/show";
import { AddCommandCompose } from "@/components/dashboard/compose/advanced/add-command";
import { IsolatedDeploymentTab } from "@/components/dashboard/compose/advanced/add-isolation";
import { FreshVolumes } from "@/components/dashboard/compose/advanced/fresh-volumes";
import { ShowBackups } from "@/components/dashboard/database/backups/show-backups";
import { AssignComposeNetworks } from "@/components/dashboard/networks/assign-compose-networks";
import { AssignNetworks } from "@/components/dashboard/networks/assign-networks";
import { ShowCustomCommand } from "@/components/dashboard/postgres/advanced/show-custom-command";
import { isDatabaseKind, type ServiceKind } from "@/lib/navigation";
import type { PendingEvent } from "../use-section-pending";
import type { ServiceBasics } from "../use-service";
import { BasicAuthSection } from "./basic-auth";
import { ComposeFileSection } from "./compose-file";
import { ComposeSource } from "./compose-source";
import { DangerZone } from "./danger";
import { DatabaseSettings } from "./database-settings";
import { DetailsAndIcon } from "./details";
import { DomainsSection } from "./domains";
import { EnvironmentSection } from "./environment";
import { PatchesSection } from "./patches";
import { PortsSection } from "./ports";
import { PreviewsSection } from "./previews";
import { RedirectsSection } from "./redirects";
import { ResourcesSection } from "./resources";
import { SchedulesSection } from "./schedules";
import { TraefikSection } from "./traefik";
import { VolumeBackupsSection } from "./volume-backups";
import { VolumesSection } from "./volumes";

export type SectionProps = {
	kind: ServiceKind;
	id: string;
	basics: ServiceBasics;
	pending: readonly PendingEvent[];
};

/** Swarm options few services need: collapsed until opened. */
function RareSettings({ children }: { children: React.ReactNode }) {
	return (
		<details className="group/rare">
			<summary className="flex cursor-pointer list-none items-start justify-between gap-6 [&::-webkit-details-marker]:hidden">
				<span className="flex min-w-0 flex-col gap-1">
					<span className="font-semibold text-[15px] leading-snug">Swarm</span>
					<span className="text-muted-foreground text-sm">
						Placement, update and rollback policy, health check, restart policy,
						labels and mode. Most services never need these.
					</span>
				</span>
				<span className="inline-flex h-7 shrink-0 items-center rounded-md border border-border px-2.5 font-medium text-[13px] group-open/rare:hidden">
					Show
				</span>
				<span className="hidden h-7 shrink-0 items-center rounded-md border border-border px-2.5 font-medium text-[13px] group-open/rare:inline-flex">
					Hide
				</span>
			</summary>
			<div className="pt-6">{children}</div>
		</details>
	);
}

export function SectionBody({
	slug,
	...props
}: SectionProps & { slug: string }) {
	const { kind, id, basics } = props;
	const database = isDatabaseKind(kind) ? kind : null;
	switch (slug) {
		case "general":
			if (kind === "application")
				return (
					<>
						<DetailsAndIcon {...props} />
						<ShowProviderForm applicationId={id} />
						<ShowBuildChooseForm applicationId={id} />
						<ShowBuildServer applicationId={id} />
					</>
				);
			if (kind === "compose")
				return (
					<>
						<DetailsAndIcon {...props} />
						<ComposeSource id={id} />
					</>
				);
			return database ? (
				<DatabaseSettings {...props} />
			) : (
				<DetailsAndIcon {...props} />
			);
		case "compose-file":
			return <ComposeFileSection {...props} />;
		case "environment":
			return <EnvironmentSection {...props} />;
		case "domains":
			return <DomainsSection {...props} />;
		case "ports":
			return <PortsSection {...props} />;
		case "volumes":
			return <VolumesSection {...props} />;
		case "redirects":
			return <RedirectsSection {...props} />;
		case "security":
			return <BasicAuthSection {...props} />;
		case "resources":
			return <ResourcesSection {...props} />;
		case "advanced":
			if (kind === "application")
				return (
					<>
						<AddCommand applicationId={id} />
						<AssignNetworks id={id} type="application" />
						<RareSettings>
							<ShowClusterSettings id={id} type="application" />
						</RareSettings>
					</>
				);
			if (kind === "compose")
				return (
					<>
						<AddCommandCompose composeId={id} />
						<IsolatedDeploymentTab composeId={id} />
						<AssignComposeNetworks composeId={id} />
						<ShowImport composeId={id} />
						<FreshVolumes composeId={id} />
					</>
				);
			return (
				<>
					<ShowCustomCommand id={id} type={kind as "postgres"} />
					<AssignNetworks id={id} type={kind as "postgres"} />
					{kind !== "libsql" ? (
						<RareSettings>
							<ShowClusterSettings id={id} type={kind as "postgres"} />
						</RareSettings>
					) : null}
				</>
			);
		case "traefik":
			return <TraefikSection {...props} />;
		case "previews":
			return <PreviewsSection {...props} />;
		case "patches":
			if (kind === "application" && basics.sourceType === "docker")
				return (
					<p className="py-3 text-muted-foreground text-sm">
						Patches change files in the repository before the build, so they
						need a Git source. This application deploys a Docker image.
					</p>
				);
			if (kind === "compose" && basics.sourceType !== "git")
				return (
					<p className="py-3 text-muted-foreground text-sm">
						Patches change files in the repository before the build, so they
						need a Git source. This stack's compose file is written here.
					</p>
				);
			return <PatchesSection {...props} />;
		case "schedules":
			return <SchedulesSection {...props} />;
		case "volume-backups":
			return (
				<div className="flex flex-col gap-8">
					<VolumeBackupsSection {...props} />
					{kind === "compose" ? (
						<FormSection
							title="Database backups"
							description="Dump a database that runs in this stack to S3 storage on a schedule."
						>
							<ShowBackups id={id} backupType="compose" embedded />
						</FormSection>
					) : null}
				</div>
			);
		case "danger":
			return <DangerZone {...props} />;
		default:
			return null;
	}
}
