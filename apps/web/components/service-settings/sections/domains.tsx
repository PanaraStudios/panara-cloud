"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import {
	GlobeIcon,
	PencilIcon,
	PlusIcon,
	PowerIcon,
	SearchCheckIcon,
	Trash2Icon,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DnsHelperModal } from "@/components/dashboard/application/domains/dns-helper-modal";
import {
	COMPOSE_REDEPLOY_TOAST,
	ComposeRedeployAlert,
} from "@/components/dashboard/application/domains/redeploy-hint";
import { DomainIcon } from "@/components/icons/service-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	ConfirmDialog,
	EmptyState,
	MoreMenu,
	ResourceTable,
	Th,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { waitForOp } from "@/lib/host-data";
import { serviceSettingsUrl } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { NotDeployedBadge } from "../chrome";
import { isRowPending } from "../use-section-pending";
import { useServiceRef } from "../use-service-ref";
import { AddDomainDialog } from "./add-domain-dialog";
import { countLabel, SectionToolbar } from "./kit";
import type { SectionProps } from "./registry";

const ADDRESS_PROBE_TIMEOUT_MS = 20_000;

type Validation = {
	isLoading: boolean;
	isValid?: boolean;
	error?: string;
	resolvedIp?: string;
	cdnProvider?: string;
};

export function DomainsSection({ kind, id, basics, pending }: SectionProps) {
	const type = kind as "application" | "compose";
	const ref = useServiceRef();
	const permissions = usePermissions();
	const owner = { kind: type, id };
	const rows = useQuery(api.infra.domains.listByOwner, { owner });
	const serverIp = useQuery(api.infra.domains.serverIp, { owner });
	const validateHost = useAction(api.infra.domains.validateHost);
	const probeAddresses = useMutation(api.infra.domains.probeAddresses);
	const convex = useConvex();
	const remove = useMutation(api.infra.domains.remove);
	const setEnabled = useMutation(api.infra.domains.setEnabled);
	const [validation, setValidation] = useState<Record<string, Validation>>({});
	const [deleting, setDeleting] = useState<string | null>(null);

	const newUrl = ref ? serviceSettingsUrl(ref, "domains/new") : "#";
	const editUrl = (domainId: string) =>
		ref ? serviceSettingsUrl(ref, `domains/${domainId}`) : "#";

	const toggle = async (domainId: string, enabled: boolean) => {
		try {
			const result = await setEnabled({
				domainId: domainId as Id<"domains">,
				enabled,
			});
			toast.success(
				result.enabled ? "Domain enabled" : "Domain disabled",
				result.requiresRedeploy
					? { description: COMPOSE_REDEPLOY_TOAST }
					: undefined,
			);
		} catch {
			toast.error("Error updating the domain");
		}
	};

	const validate = async (host: string) => {
		setValidation((prev) => ({ ...prev, [host]: { isLoading: true } }));
		try {
			// The server's other addresses (interfaces, public IP) count too;
			// without them only the configured IP is checked.
			const probeJobId = await probeAddresses({ owner })
				.then((jobId) =>
					waitForOp(convex, jobId, ADDRESS_PROBE_TIMEOUT_MS).then(() => jobId),
				)
				.catch(() => undefined);
			const result = await validateHost({ owner, host, probeJobId });
			setValidation((prev) => ({
				...prev,
				[host]: {
					isLoading: false,
					isValid: result.isValid,
					error: result.error,
					resolvedIp: result.resolvedIp,
					cdnProvider: result.cdnProvider,
				},
			}));
		} catch (error) {
			setValidation((prev) => ({
				...prev,
				[host]: {
					isLoading: false,
					isValid: false,
					error: errorMessage(error),
				},
			}));
		}
	};

	// The Overview's "Add domain" links here with ?add=1.
	const searchParams = useSearchParams();
	const [adding, setAdding] = useState(
		() => type === "application" && searchParams.get("add") === "1",
	);
	const add = !permissions.domain.create ? null : type === "application" ? (
		<Button variant="outline" onClick={() => setAdding(true)}>
			<PlusIcon data-icon="inline-start" />
			Add domain
		</Button>
	) : (
		<Button
			variant="outline"
			nativeButton={false}
			render={<Link href={newUrl} />}
		>
			<PlusIcon data-icon="inline-start" />
			Add domain
		</Button>
	);

	if (rows === undefined) return null;

	return (
		<div className="flex min-w-0 flex-col gap-4">
			{rows.length === 0 ? (
				<EmptyState
					icon={GlobeIcon}
					title="No domains"
					description="Add a domain to reach this service from the internet."
				>
					{add}
				</EmptyState>
			) : (
				<>
					<SectionToolbar actions={add}>
						{countLabel(rows.length, "domain")}
					</SectionToolbar>
					<ResourceTable
						headers={
							<>
								<Th>Host</Th>
								<Th className="max-md:hidden">Path</Th>
								<Th className="max-md:hidden">Port</Th>
								<Th>HTTPS</Th>
								<Th>Status</Th>
								<Th className="w-10" />
							</>
						}
					>
						{rows.map((domain) => {
							const check = validation[domain.host];
							const url = `${domain.https ? "https" : "http"}://${domain.host}${domain.path === "/" ? "" : domain.path}`;
							return (
								<TableRow key={domain._id}>
									<TableCell className="max-w-72">
										<div className="flex min-w-0 items-center gap-2">
											<DomainIcon https={domain.https} />
											<a
												href={url}
												target="_blank"
												rel="noreferrer"
												className="truncate font-mono text-[13px] hover:underline"
											>
												{domain.host}
											</a>
											{isRowPending(pending, { host: domain.host }) ? (
												<NotDeployedBadge />
											) : null}
										</div>
										{type === "compose" && domain.serviceName ? (
											<div className="pl-6 text-muted-foreground text-xs">
												→ {domain.serviceName}
											</div>
										) : null}
									</TableCell>
									<TableCell className="font-mono text-[13px] text-muted-foreground max-md:hidden">
										{domain.path}
									</TableCell>
									<TableCell className="font-mono text-[13px] text-muted-foreground max-md:hidden">
										{domain.port}
									</TableCell>
									<TableCell className="text-muted-foreground">
										{domain.https
											? domain.certificateType === "letsencrypt"
												? "Let's Encrypt"
												: domain.certificateType === "custom"
													? "Custom"
													: "On"
											: "Off"}
									</TableCell>
									<TableCell>
										<div className="flex flex-wrap items-center gap-1.5">
											{domain.enabled ? (
												<Badge variant="success" dot>
													Enabled
												</Badge>
											) : (
												<Badge variant="secondary" dot>
													Disabled
												</Badge>
											)}
											{check?.isLoading ? (
												<Badge variant="secondary">Checking DNS…</Badge>
											) : check ? (
												<Badge
													variant={check.isValid ? "success" : "destructive"}
													title={check.error ?? check.resolvedIp}
												>
													{check.isValid
														? check.cdnProvider
															? `DNS ok · ${check.cdnProvider}`
															: "DNS ok"
														: "DNS invalid"}
												</Badge>
											) : null}
										</div>
									</TableCell>
									<TableCell className="text-right">
										<div className="flex items-center justify-end gap-1">
											<DnsHelperModal
												domain={domain}
												serverIp={serverIp ?? undefined}
											/>
											<MoreMenu>
												{permissions.domain.create ? (
													<DropdownMenuItem
														render={<Link href={editUrl(domain._id)} />}
													>
														<PencilIcon className="text-muted-foreground" />
														Edit
													</DropdownMenuItem>
												) : null}
												<DropdownMenuItem onClick={() => validate(domain.host)}>
													<SearchCheckIcon className="text-muted-foreground" />
													Check DNS
												</DropdownMenuItem>
												{permissions.domain.create ? (
													<DropdownMenuItem
														onClick={() => toggle(domain._id, !domain.enabled)}
													>
														<PowerIcon className="text-muted-foreground" />
														{domain.enabled ? "Disable" : "Enable"}
													</DropdownMenuItem>
												) : null}
												{permissions.domain.delete ? (
													<DropdownMenuItem
														variant="destructive"
														onClick={() => setDeleting(domain._id)}
													>
														<Trash2Icon className="text-muted-foreground" />
														Delete
													</DropdownMenuItem>
												) : null}
											</MoreMenu>
										</div>
									</TableCell>
								</TableRow>
							);
						})}
					</ResourceTable>
					{type === "compose" ? <ComposeRedeployAlert /> : null}
				</>
			)}
			{type === "application" ? (
				<AddDomainDialog
					open={adding}
					onOpenChange={(open) => {
						setAdding(open);
						// Drop ?add=1 so a refresh doesn't reopen the dialog.
						if (!open && searchParams.get("add")) {
							window.history.replaceState(null, "", window.location.pathname);
						}
					}}
					applicationId={id}
					serviceName={basics.name}
					fullFormHref={newUrl}
				/>
			) : null}
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(open) => {
					if (!open) setDeleting(null);
				}}
				title="Delete domain?"
				description="Traffic for this hostname stops reaching the service."
				onConfirm={async () => {
					if (!deleting) return;
					await remove({ domainId: deleting as Id<"domains"> });
					toast.success(
						"Domain deleted",
						type === "compose"
							? { description: COMPOSE_REDEPLOY_TOAST }
							: undefined,
					);
					setDeleting(null);
				}}
			/>
		</div>
	);
}
