"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import { ArchiveIcon } from "lucide-react";
import { toast } from "sonner";
import { BrandTile, s3Brand } from "@/components/icons/settings-icons";
import { ListLoading } from "@/components/settings/form-kit";
import { TableCell, TableRow } from "@/components/ui/table";
import { ResourceTable, Th } from "@/components/ui-kit/primitives";
import {
	RowMenu,
	SettingsEmpty,
	SettingsListHeader,
} from "@/components/ui-kit/settings-list";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { S3_PROVIDERS } from "./constants";

export const ShowDestinations = () => {
	const { active } = useOrganization();
	const destinations = useQuery(api.databases.destinations.list, {
		organizationId: active.id,
	});
	const remove = useMutation(api.databases.destinations.remove);
	const permissions = usePermissions();
	const providerName = (key?: string) =>
		S3_PROVIDERS.find((provider) => provider.key === key)?.name ?? key ?? "S3";

	return (
		<div className="flex w-full flex-col gap-6">
			<SettingsListHeader
				title="S3 storage"
				description="Buckets that database, volume and panel backups upload to. Any S3-compatible provider works."
				addHref={
					permissions?.destination.create ? "/settings/s3/new" : undefined
				}
				addLabel="Add destination"
			/>
			{destinations === undefined ? (
				<ListLoading />
			) : destinations.length === 0 ? (
				<SettingsEmpty
					icon={ArchiveIcon}
					title="No storage yet"
					description="Add an S3-compatible bucket (AWS, Cloudflare R2, Wasabi, MinIO…) before scheduling backups."
				/>
			) : (
				<ResourceTable
					headers={
						<>
							<Th>Name</Th>
							<Th>Provider</Th>
							<Th>Bucket · region</Th>
							<Th className="hidden 2xl:table-cell">Endpoint</Th>
							<Th className="w-12" />
						</>
					}
				>
					{destinations.map((destination) => (
						<TableRow key={destination._id}>
							<TableCell>
								<span className="flex items-center gap-3 font-medium">
									<BrandTile
										brand={s3Brand(destination.provider, destination.endpoint)}
									/>
									{destination.name}
								</span>
							</TableCell>
							<TableCell className="max-w-52 truncate">
								{providerName(destination.provider)}
							</TableCell>
							<TableCell className="font-mono text-[13px]">
								{destination.bucket}
								<span className="text-muted-foreground">
									{" "}
									· {destination.region || "auto"}
								</span>
							</TableCell>
							<TableCell className="hidden max-w-64 truncate font-mono text-[13px] text-muted-foreground 2xl:table-cell">
								{destination.endpoint}
							</TableCell>
							<TableCell className="text-right">
								<RowMenu
									label={destination.name}
									editHref={
										permissions?.destination.create
											? `/settings/s3/${destination._id}`
											: undefined
									}
									deleteTitle="Delete destination?"
									deleteDescription="Backups scheduled to it stop until they get another destination."
									onDelete={
										permissions?.destination.delete
											? async () => {
													try {
														await remove({ destinationId: destination._id });
														toast.success("Destination deleted");
													} catch (error) {
														toast.error(errorMessage(error));
													}
												}
											: undefined
									}
								/>
							</TableCell>
						</TableRow>
					))}
				</ResourceTable>
			)}
		</div>
	);
};
