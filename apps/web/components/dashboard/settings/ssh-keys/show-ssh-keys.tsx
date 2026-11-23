"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import copy from "copy-to-clipboard";
import { format } from "date-fns";
import { KeyRoundIcon } from "lucide-react";
import { toast } from "sonner";
import { LogoTile } from "@/components/icons/settings-icons";
import { ListLoading } from "@/components/settings/form-kit";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
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

const shortKey = (key: string) => {
	const [type, body = "", comment = ""] = key.trim().split(/\s+/);
	return `${type} ${body.slice(0, 9)}…${body.slice(-4)}${comment ? ` ${comment}` : ""}`;
};

export const ShowDestinations = () => {
	const { active } = useOrganization();
	const keys = useQuery(api.sshKeys.list, { organizationId: active.id });
	const remove = useMutation(api.sshKeys.remove);
	const permissions = usePermissions();

	return (
		<div className="flex w-full flex-col gap-6">
			<SettingsListHeader
				title="SSH keys"
				description="Keys Panara Cloud uses to reach your servers and to clone private repositories over SSH."
				addHref={
					permissions?.sshKeys.create ? "/settings/ssh-keys/new" : undefined
				}
				addLabel="Add key"
			/>
			{keys === undefined ? (
				<ListLoading />
			) : keys.length === 0 ? (
				<SettingsEmpty
					icon={KeyRoundIcon}
					title="No SSH keys yet"
					description="Generate an ED25519 key (recommended) or import one you already use."
				/>
			) : (
				<ResourceTable
					headers={
						<>
							<Th>Name</Th>
							<Th>Public key</Th>
							<Th>Last used</Th>
							<Th>Created</Th>
							<Th className="w-12" />
						</>
					}
				>
					{keys.map((key) => (
						<TableRow key={key._id}>
							<TableCell>
								<div className="flex items-center gap-3">
									<LogoTile glyph>
										<KeyRoundIcon />
									</LogoTile>
									<div className="flex min-w-0 flex-col">
										<span className="font-medium">{key.name}</span>
										{key.description ? (
											<span className="text-muted-foreground text-xs">
												{key.description}
											</span>
										) : null}
									</div>
								</div>
							</TableCell>
							<TableCell className="font-mono text-[13px] text-muted-foreground">
								{shortKey(key.publicKey)}
							</TableCell>
							<TableCell className="text-muted-foreground">
								{key.lastUsedAt
									? format(new Date(key.lastUsedAt), "MMM d")
									: "Not used"}
							</TableCell>
							<TableCell className="text-muted-foreground">
								{format(new Date(key._creationTime), "MMM d")}
							</TableCell>
							<TableCell className="text-right">
								<RowMenu
									label={key.name}
									editHref={
										permissions?.sshKeys.create
											? `/settings/ssh-keys/${key._id}`
											: undefined
									}
									deleteTitle="Delete SSH key?"
									deleteDescription="Servers and services using it lose access until they get another key."
									onDelete={
										permissions?.sshKeys.delete
											? async () => {
													try {
														await remove({ sshKeyId: key._id });
														toast.success("SSH key deleted");
													} catch (error) {
														toast.error(errorMessage(error));
													}
												}
											: undefined
									}
								>
									<DropdownMenuItem
										onClick={() => {
											copy(key.publicKey);
											toast.success("Public key copied");
										}}
									>
										Copy public key
									</DropdownMenuItem>
								</RowMenu>
							</TableCell>
						</TableRow>
					))}
				</ResourceTable>
			)}
		</div>
	);
};
