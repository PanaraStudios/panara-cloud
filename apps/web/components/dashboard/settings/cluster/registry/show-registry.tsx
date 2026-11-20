"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import { PackageIcon } from "lucide-react";
import { toast } from "sonner";
import { BrandTile, registryBrand } from "@/components/icons/settings-icons";
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

export const ShowRegistry = () => {
	const { active } = useOrganization();
	const remove = useMutation(api.sources.registries.remove);
	const registries = useQuery(api.sources.registries.list, {
		organizationId: active.id,
	});
	const permissions = usePermissions();

	return (
		<div className="flex w-full flex-col gap-6">
			<SettingsListHeader
				title="Registries"
				description="Private image registries to pull from, and to push builds to for multi-server deploys."
				addHref={
					permissions?.registry.create ? "/settings/registries/new" : undefined
				}
				addLabel="Add registry"
			/>
			{registries === undefined ? (
				<ListLoading />
			) : registries.length === 0 ? (
				<SettingsEmpty
					icon={PackageIcon}
					title="No registries yet"
					description="Add Docker Hub, GHCR, ECR or any registry to pull private images and push builds."
				/>
			) : (
				<ResourceTable
					headers={
						<>
							<Th>Name</Th>
							<Th>Registry</Th>
							<Th>Username</Th>
							<Th>Image prefix</Th>
							<Th className="w-12" />
						</>
					}
				>
					{registries.map((registry) => (
						<TableRow key={registry._id}>
							<TableCell>
								<span className="flex items-center gap-3 font-medium">
									<BrandTile brand={registryBrand(registry.registryUrl)} />
									{registry.registryName}
								</span>
							</TableCell>
							<TableCell className="font-mono text-[13px]">
								{registry.registryUrl || "docker.io"}
							</TableCell>
							<TableCell className="font-mono text-[13px] text-muted-foreground">
								{registry.username}
							</TableCell>
							<TableCell className="font-mono text-[13px]">
								{registry.imagePrefix || (
									<span className="text-muted-foreground">—</span>
								)}
							</TableCell>
							<TableCell className="text-right">
								<RowMenu
									label={registry.registryName}
									editHref={
										permissions?.registry.create
											? `/settings/registries/${registry._id}`
											: undefined
									}
									deleteTitle="Delete registry?"
									deleteDescription="Services pulling from it need another registry before their next deploy."
									onDelete={
										permissions?.registry.delete
											? async () => {
													try {
														await remove({ registryId: registry._id });
														toast.success("Registry deleted");
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
