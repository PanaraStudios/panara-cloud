"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { ActivityIcon, ArrowRightFromLineIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { LogoTile } from "@/components/icons/settings-icons";
import { telemetryProviderIcons } from "@/components/icons/telemetry-provider-icons";
import { ListLoading, StatusDot } from "@/components/settings/form-kit";
import { TableCell, TableRow } from "@/components/ui/table";
import { ResourceTable, Section, Th } from "@/components/ui-kit/primitives";
import { RowMenu, SettingsListHeader } from "@/components/ui-kit/settings-list";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { useReapplyWarning } from "./reapply-warning";

interface TelemetryProviderRowProps {
	provider: {
		telemetryProviderId: string;
		name: string;
		enabled: boolean;
		providerType: string;
		signals: string[];
	};
	typeLabel: string;
	canEdit: boolean;
	canDelete: boolean;
	onDeleted: () => void;
}

const TelemetryProviderRow = ({
	provider,
	typeLabel,
	canEdit,
	canDelete,
	onDeleted,
}: TelemetryProviderRowProps) => {
	const remove = useMutation(api.platform.telemetry.remove);
	const [isRemoving, setIsRemoving] = useState(false);
	const { active } = useOrganization();
	const targets = useQuery(
		api.platform.telemetry.vectorStatus,
		canDelete ? { organizationId: active.id } : "skip",
	);
	const reapplyWarning = useReapplyWarning();
	const ProviderIcon =
		telemetryProviderIcons[
			provider.providerType as keyof typeof telemetryProviderIcons
		];

	return (
		<TableRow>
			<TableCell>
				<span className="flex items-center gap-3 font-medium">
					<LogoTile glyph={!ProviderIcon}>
						{ProviderIcon ? <ProviderIcon /> : <ActivityIcon />}
					</LogoTile>
					{provider.name}
				</span>
			</TableCell>
			<TableCell>{typeLabel}</TableCell>
			<TableCell>
				{provider.signals
					.map((signal) => signal.charAt(0).toUpperCase() + signal.slice(1))
					.join(", ")}
			</TableCell>
			<TableCell>
				<StatusDot tone={provider.enabled ? "success" : "secondary"}>
					{provider.enabled ? "On" : "Off"}
				</StatusDot>
			</TableCell>
			<TableCell className="text-right">
				<RowMenu
					label={provider.name}
					editHref={
						canEdit
							? `/settings/logs-and-metrics/${provider.telemetryProviderId}`
							: undefined
					}
					deleteTitle="Delete destination?"
					deleteDescription="Every agent shipping to it is re-applied without it, and removed if nothing is left."
					onDelete={
						canDelete
							? async () => {
									setIsRemoving(true);
									await remove({
										telemetryProviderId:
											provider.telemetryProviderId as Id<"telemetryProviders">,
									})
										.then(async (result) => {
											onDeleted();
											const warning = await reapplyWarning(
												result.jobIds,
												targets,
											);
											if (warning) {
												toast.warning("Destination deleted", {
													description: warning,
												});
											} else {
												toast.success(
													"Destination deleted. The agents that used it were re-applied.",
												);
											}
										})
										.catch((error) => {
											toast.error("Error deleting the destination", {
												description: errorMessage(error),
											});
										})
										.finally(() => setIsRemoving(false));
								}
							: undefined
					}
				/>
				{isRemoving ? <span className="sr-only">Deleting…</span> : null}
			</TableCell>
		</TableRow>
	);
};

export const ShowTelemetryProviders = () => {
	const { active } = useOrganization();
	const providers = useQuery(api.platform.telemetry.list, {
		organizationId: active.id,
	});
	const data = providers?.map((provider) => ({
		...provider,
		telemetryProviderId: provider._id,
	}));
	const isPending = providers === undefined;
	const availableTypes = useQuery(api.platform.telemetry.availableTypes, {});
	const permissions = usePermissions();

	return (
		<>
			<SettingsListHeader
				title="Logs & metrics"
				description="Ship container logs and server metrics to your observability stack."
				addHref={
					permissions?.telemetryProvider.create
						? "/settings/logs-and-metrics/new"
						: undefined
				}
				addLabel="Add destination"
			/>
			<Section title="Destinations" icon={ArrowRightFromLineIcon}>
				<div className="[&>.frame]:pt-4">
					{isPending ? (
						<ListLoading />
					) : data?.length === 0 ? (
						<p className="py-3 text-muted-foreground text-sm">
							No destinations yet.
							{availableTypes?.length
								? ` Supported: ${availableTypes.map((type) => type.label).join(", ")}.`
								: null}
						</p>
					) : (
						<ResourceTable
							headers={
								<>
									<Th>Name</Th>
									<Th>Type</Th>
									<Th>Sends</Th>
									<Th>Enabled</Th>
									<Th className="w-12" />
								</>
							}
						>
							{data?.map((provider) => (
								<TelemetryProviderRow
									key={provider.telemetryProviderId}
									provider={provider}
									typeLabel={
										availableTypes?.find(
											(t) => t.type === provider.providerType,
										)?.label ?? provider.providerType
									}
									canEdit={!!permissions?.telemetryProvider.create}
									canDelete={!!permissions?.telemetryProvider.delete}
									onDeleted={() => {}}
								/>
							))}
						</ResourceTable>
					)}
				</div>
			</Section>
		</>
	);
};
