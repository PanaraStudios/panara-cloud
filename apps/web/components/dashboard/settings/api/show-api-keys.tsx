"use client";

import { api } from "@panara-cloud/backend/api";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { format, formatDistanceToNow } from "date-fns";
import { KeyRoundIcon } from "lucide-react";
import { toast } from "sonner";
import { LogoTile } from "@/components/icons/settings-icons";
import { ListLoading } from "@/components/settings/form-kit";
import { TableCell, TableRow } from "@/components/ui/table";
import { ResourceTable, Th } from "@/components/ui-kit/primitives";
import { RowMenu, SettingsEmpty } from "@/components/ui-kit/settings-list";
import { errorMessage } from "@/lib/auth/errors";

const formatInterval = (ms: number) => {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h`;
	return `${Math.round(hours / 24)} d`;
};

export const ShowApiKeys = () => {
	const { isAuthenticated } = useConvexAuth();
	const keys = useQuery(
		api.platform.apiKeys.listMine,
		isAuthenticated ? {} : "skip",
	);
	const data = keys && {
		user: {
			apiKeys: keys.map((key) => ({
				id: key._id,
				name: key.name,
				prefix: key.prefix,
				createdAt: key._creationTime,
				expiresAt: key.expiresAt,
				rateLimit: key.rateLimit,
				requestLimit: key.requestLimit,
			})),
		},
	};
	const revokeApiKey = useMutation(api.platform.apiKeys.revoke);

	const now = Date.now();
	return (
		<>
			{keys === undefined ? (
				<ListLoading />
			) : keys.length === 0 ? (
				<SettingsEmpty
					icon={KeyRoundIcon}
					title="No API keys yet"
					description="Create one for CI deploys, Terraform or your own scripts."
				/>
			) : (
				<ResourceTable
					headers={
						<>
							<Th>Name</Th>
							<Th>Key</Th>
							<Th>Rate limit</Th>
							<Th>Expires</Th>
							<Th>Created</Th>
							<Th className="w-12" />
						</>
					}
				>
					{data?.user.apiKeys.map((apiKey) => {
						const expired = apiKey.expiresAt ? apiKey.expiresAt < now : false;
						const soon =
							apiKey.expiresAt && !expired
								? apiKey.expiresAt - now < 7 * 24 * 60 * 60 * 1000
								: false;
						return (
							<TableRow key={apiKey.id}>
								<TableCell>
									<span className="flex items-center gap-3 font-medium">
										<LogoTile glyph>
											<KeyRoundIcon />
										</LogoTile>
										{apiKey.name}
									</span>
								</TableCell>
								<TableCell className="font-mono text-[13px] text-muted-foreground">
									{apiKey.prefix ? `${apiKey.prefix}…` : "pnr_…"}
								</TableCell>
								<TableCell>
									{apiKey.rateLimit ? (
										`${apiKey.rateLimit.max} / ${formatInterval(apiKey.rateLimit.timeWindowMs)}`
									) : (
										<span className="text-muted-foreground">No limit</span>
									)}
								</TableCell>
								<TableCell
									className={
										expired
											? "text-destructive"
											: soon
												? "text-warning"
												: undefined
									}
								>
									{apiKey.expiresAt
										? expired
											? `Expired ${format(new Date(apiKey.expiresAt), "MMM d")}`
											: `In ${formatDistanceToNow(new Date(apiKey.expiresAt))}`
										: "Never"}
								</TableCell>
								<TableCell className="text-muted-foreground">
									{format(new Date(apiKey.createdAt), "MMM d")}
								</TableCell>
								<TableCell className="text-right">
									<RowMenu
										label={apiKey.name}
										deleteTitle="Delete API key?"
										deleteDescription="Anything using this key stops working. This can't be undone."
										onDelete={async () => {
											try {
												await revokeApiKey({ apiKeyId: apiKey.id });
												toast.success("API key deleted");
											} catch (error) {
												toast.error(errorMessage(error));
											}
										}}
									/>
								</TableCell>
							</TableRow>
						);
					})}
				</ResourceTable>
			)}
		</>
	);
};
