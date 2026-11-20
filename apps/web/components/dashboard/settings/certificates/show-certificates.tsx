"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import { ShieldCheckIcon } from "lucide-react";
import { toast } from "sonner";
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
import { cn } from "@/lib/utils";
import {
	extractLeafCommonName,
	getCertificateChainInfo,
	getExpirationStatus,
} from "./utils";

const DOT = {
	valid: "bg-success",
	warning: "bg-warning",
	expired: "bg-destructive",
	unknown: "bg-muted-foreground/50",
} as const;

export const ShowCertificates = () => {
	const { active } = useOrganization();
	const remove = useMutation(api.infra.certificates.remove);
	const certificates = useQuery(api.infra.certificates.listDetailed, {
		organizationId: active.id,
	});
	const permissions = usePermissions();

	return (
		<div className="flex w-full flex-col gap-6">
			<SettingsListHeader
				title="Certificates"
				description="Your own TLS certificates, for domains Let's Encrypt can't issue. Most domains don't need one."
				addHref={
					permissions?.certificate.create
						? "/settings/certificates/new"
						: undefined
				}
				addLabel="Add certificate"
			/>
			{certificates === undefined ? (
				<ListLoading />
			) : certificates.length === 0 ? (
				<SettingsEmpty
					icon={ShieldCheckIcon}
					title="No certificates"
					description="Domains get Let's Encrypt certificates automatically. Upload one here only for wildcard or internal CA certificates."
				/>
			) : (
				<ResourceTable
					headers={
						<>
							<Th>Name</Th>
							<Th>Common name</Th>
							<Th>Server</Th>
							<Th>Expires</Th>
							<Th className="w-12" />
						</>
					}
				>
					{certificates.map((certificate) => {
						const expiration = getExpirationStatus(certificate.certificateData);
						const chain = getCertificateChainInfo(certificate.certificateData);
						const commonName = extractLeafCommonName(
							certificate.certificateData,
						);
						return (
							<TableRow key={certificate._id}>
								<TableCell>
									<span
										className={cn(
											"flex items-center gap-3 font-medium",
											expiration.status === "expired" &&
												"text-muted-foreground",
										)}
									>
										<LogoTile glyph>
											<ShieldCheckIcon />
										</LogoTile>
										{certificate.name}
									</span>
								</TableCell>
								<TableCell className="font-mono text-[13px]">
									{commonName ?? "—"}
									{chain.isChain ? (
										<span className="text-muted-foreground">
											{" "}
											· chain of {chain.count}
										</span>
									) : null}
								</TableCell>
								<TableCell>
									{certificate.server
										? certificate.server.name
										: "Panara Cloud host"}
								</TableCell>
								<TableCell>
									<span
										className={cn(
											"flex items-center gap-2",
											expiration.status === "expired" && "text-destructive",
										)}
									>
										<span
											className={cn(
												"size-1.5 rounded-full",
												DOT[expiration.status],
											)}
										/>
										{expiration.message}
									</span>
								</TableCell>
								<TableCell className="text-right">
									<RowMenu
										label={certificate.name}
										editHref={
											permissions?.certificate.update
												? `/settings/certificates/${certificate._id}`
												: undefined
										}
										deleteTitle="Delete certificate?"
										deleteDescription="Traefik stops serving it; affected domains fall back to Let's Encrypt."
										onDelete={
											permissions?.certificate.delete
												? async () => {
														try {
															await remove({ certificateId: certificate._id });
															toast.success("Certificate deleted");
														} catch (error) {
															toast.error(errorMessage(error));
														}
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
