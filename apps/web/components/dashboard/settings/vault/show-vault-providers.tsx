"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import { LockIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { LogoTile } from "@/components/icons/settings-icons";
import { vaultProviderIcons } from "@/components/icons/vault-provider-icons";
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

const providerLabels: Record<string, string> = {
	hashicorp: "HashiCorp Vault",
	infisical: "Infisical",
	aws: "AWS Secrets Manager",
	"aws-parameter-store": "AWS Parameter Store",
	doppler: "Doppler",
	azure: "Azure Key Vault",
	scaleway: "Scaleway Secret Manager",
	phase: "Phase",
};

export const ShowVaultProviders = () => {
	const { active } = useOrganization();
	const removeProvider = useMutation(api.platform.vault.remove);
	const [, setIsRemoving] = useState(false);
	const data = useQuery(api.platform.vault.list, {
		organizationId: active.id,
	});
	const isPending = data === undefined;
	const permissions = usePermissions();

	return (
		<div className="flex w-full flex-col gap-6">
			<SettingsListHeader
				title="Secrets"
				description="Pull environment values from a vault at deploy time instead of storing them in Panara Cloud."
				addHref={
					permissions?.vaultProvider.create
						? "/settings/secrets/new"
						: undefined
				}
				addLabel="Connect vault"
			/>
			{isPending ? (
				<ListLoading />
			) : data?.length === 0 ? (
				<SettingsEmpty
					icon={LockIcon}
					title="No vaults connected"
					description="Infisical, HashiCorp Vault / OpenBao, AWS, Doppler, Azure Key Vault, Scaleway or Phase."
				/>
			) : (
				<ResourceTable
					headers={
						<>
							<Th>Name</Th>
							<Th>Provider</Th>
							<Th>Projects that can use it</Th>
							<Th>Reference</Th>
							<Th className="w-12" />
						</>
					}
				>
					{data?.map((provider) => {
						const ProviderIcon = vaultProviderIcons[provider.providerType];
						return (
							<TableRow key={provider._id}>
								<TableCell>
									<span className="flex items-center gap-3 font-medium">
										<LogoTile>
											<ProviderIcon />
										</LogoTile>
										{provider.name}
									</span>
								</TableCell>
								<TableCell>
									{providerLabels[provider.providerType] ??
										provider.providerType}
								</TableCell>
								<TableCell
									className={
										provider.assignments.length === 0
											? "text-warning"
											: undefined
									}
								>
									{provider.assignments.length === 0
										? "Not assigned yet"
										: `${provider.assignments.length} ${provider.assignments.length === 1 ? "project" : "projects"}`}
								</TableCell>
								<TableCell className="font-mono text-[13px] text-muted-foreground">
									{`\${{vault.${provider.name}.…}}`}
								</TableCell>
								<TableCell className="text-right">
									<RowMenu
										label={provider.name}
										editHref={
											permissions?.vaultProvider.update
												? `/settings/secrets/${provider._id}`
												: undefined
										}
										deleteTitle="Delete vault?"
										deleteDescription="Variables that reference it stop resolving on the next deploy."
										onDelete={
											permissions?.vaultProvider.delete
												? async () => {
														setIsRemoving(true);
														await removeProvider({
															vaultProviderId: provider._id,
														})
															.then(() => toast.success("Vault deleted"))
															.catch((error) =>
																toast.error(errorMessage(error)),
															)
															.finally(() => setIsRemoving(false));
													}
												: undefined
										}
									/>
								</TableCell>
							</TableRow>
						);
					})}
				</ResourceTable>
			)}
			<p className="text-muted-foreground text-sm">
				Reference a secret in any environment variable with{" "}
				<code className="font-mono text-[13px]">
					{"${{vault.<name>.<secret>}}"}
				</code>
				.
			</p>
		</div>
	);
};
