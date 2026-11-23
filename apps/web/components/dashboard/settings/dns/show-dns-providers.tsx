"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import { Globe } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { dnsProviderIcons } from "@/components/icons/dns-provider-icons";
import { LogoTile } from "@/components/icons/settings-icons";
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
import Link from "@/lib/router/link";

const providerLabels: Record<string, string> = {
	cloudflare: "Cloudflare",
	route53: "AWS Route53",
	porkbun: "Porkbun",
	infomaniak: "Infomaniak",
	ovh: "OVHcloud",
};

export const ShowDnsProviders = () => {
	const [removingId, setRemovingId] = useState<string | null>(null);
	const { active } = useOrganization();
	const mutateAsync = useMutation(api.platform.dns.remove);
	const providers = useQuery(api.platform.dns.list, {
		organizationId: active.id,
	});
	const data = providers?.map((provider) => ({
		...provider,
		dnsProviderId: provider._id,
	}));
	const isPending = providers === undefined;
	const permissions = usePermissions();

	return (
		<div className="flex w-full flex-col gap-6">
			<SettingsListHeader
				title="DNS"
				description="Connect a DNS provider and Panara Cloud can create records when you add a domain."
				addHref={
					permissions?.dnsProvider.create ? "/settings/dns/new" : undefined
				}
				addLabel="Connect provider"
			/>
			{isPending ? (
				<ListLoading />
			) : data?.length === 0 ? (
				<SettingsEmpty
					icon={Globe}
					title="No DNS providers connected"
					description="Add Cloudflare, Route53, Porkbun, Infomaniak or OVHcloud credentials to manage records without leaving Panara Cloud."
				/>
			) : (
				<ResourceTable
					headers={
						<>
							<Th>Name</Th>
							<Th>Provider</Th>
							<Th>Zones</Th>
							<Th className="w-12" />
						</>
					}
				>
					{data?.map((provider) => {
						const ProviderIcon = dnsProviderIcons[provider.providerType];
						const href = `/settings/dns/${provider.dnsProviderId}`;
						return (
							<TableRow key={provider.dnsProviderId}>
								<TableCell>
									<Link
										href={href}
										className="flex items-center gap-3 font-medium hover:underline"
									>
										<LogoTile>
											<ProviderIcon />
										</LogoTile>
										{provider.name}
									</Link>
								</TableCell>
								<TableCell>
									{providerLabels[provider.providerType] ??
										provider.providerType}
								</TableCell>
								<TableCell>
									<Link
										href={href}
										className="text-muted-foreground hover:text-foreground"
									>
										View zones →
									</Link>
								</TableCell>
								<TableCell className="text-right">
									<RowMenu
										label={provider.name}
										editHref={
											permissions?.dnsProvider.update
												? `/settings/dns/${provider.dnsProviderId}/edit`
												: undefined
										}
										deleteTitle="Delete DNS provider?"
										deleteDescription="Domains that rely on it for their records need to be updated by hand."
										onDelete={
											permissions?.dnsProvider.delete
												? async () => {
														setRemovingId(provider.dnsProviderId);
														await mutateAsync({
															dnsProviderId: provider.dnsProviderId,
														})
															.then(() => toast.success("DNS provider deleted"))
															.catch((error) =>
																toast.error("Error deleting the DNS provider", {
																	description: errorMessage(error),
																}),
															)
															.finally(() => setRemovingId(null));
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
		</div>
	);
};
