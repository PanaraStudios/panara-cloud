"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useQuery } from "convex/react";
import { Globe } from "lucide-react";
import Link from "next/link";
import { FormError, ListLoading } from "@/components/settings/form-kit";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	DetailHeader,
	EmptyState,
	ResourceTable,
	Th,
} from "@/components/ui-kit/primitives";
import { useActionQuery } from "./use-action-query";

interface Props {
	dnsProviderId: string;
}

const RecordCount = ({
	dnsProviderId,
	zoneId,
}: {
	dnsProviderId: string;
	zoneId: string;
}) => {
	const { data, isPending, isError } = useActionQuery(
		api.platform.dnsActions.listRecords,
		{ dnsProviderId: dnsProviderId as Id<"dnsProviders">, zoneId },
		`dns-records:${dnsProviderId}:${zoneId}`,
	);

	if (isPending) return <span className="text-muted-foreground">…</span>;

	if (isError || !data) {
		return <span className="text-muted-foreground">Unavailable</span>;
	}

	return (
		<span className="text-muted-foreground tabular-nums">
			{data.length === 0
				? "No records"
				: `${data.length} record${data.length === 1 ? "" : "s"}`}
		</span>
	);
};

export const ShowDnsZones = ({ dnsProviderId }: Props) => {
	const provider = useQuery(api.platform.dns.get, { dnsProviderId });
	const zones = useActionQuery(
		api.platform.dnsActions.listZones,
		provider ? { dnsProviderId: provider._id } : "skip",
		`dns-zones:${dnsProviderId}`,
	);
	const { data } = zones;
	const notFound = provider === null;
	const isPending = provider === undefined || zones.isPending;
	const isError = notFound || zones.isError;
	const error = notFound ? new Error("DNS provider not found") : zones.error;

	return (
		<div className="flex w-full flex-col gap-6">
			<DetailHeader
				backHref="/settings/dns"
				backLabel="Back to DNS providers"
				title={provider?.name ?? "Domains"}
				description="Domains these credentials can manage. Open one to edit its records."
			/>
			{isError ? (
				<FormError
					title="Couldn't load the domains from this provider."
					message={error?.message}
				/>
			) : isPending ? (
				<ListLoading />
			) : data?.length === 0 ? (
				<EmptyState
					icon={Globe}
					title="No domains found"
					description="These credentials can't reach any zone. Check that the token has access to at least one domain."
				/>
			) : (
				<ResourceTable
					headers={
						<>
							<Th>Domain</Th>
							<Th>Records</Th>
						</>
					}
				>
					{data?.map((zone) => (
						<TableRow key={zone.id}>
							<TableCell>
								<Link
									href={`/settings/dns/${dnsProviderId}/${zone.id}`}
									className="font-medium underline-offset-4 hover:underline"
								>
									{zone.name}
								</Link>
							</TableCell>
							<TableCell>
								<RecordCount dnsProviderId={dnsProviderId} zoneId={zone.id} />
							</TableCell>
						</TableRow>
					))}
				</ResourceTable>
			)}
		</div>
	);
};
