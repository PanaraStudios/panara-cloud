"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { formatDistanceToNow } from "date-fns";
import { Box, Trash2 } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { toSandbox } from "./sandbox-data";
import { SandboxStatusBadge } from "./sandbox-status-badge";

export const formatExpiresIn = (expiresAt: Date | null, status: string) => {
	if (status !== "running" || !expiresAt) return "—";
	if (expiresAt.getTime() <= Date.now()) return "expired";
	return formatDistanceToNow(expiresAt, { addSuffix: true });
};

interface Props {
	serverId?: string;
}

export const ShowSandboxes = ({ serverId }: Props) => {
	const permissions = usePermissions();
	const { active } = useOrganization();
	const rows = useQuery(api.live.sandboxes.list, {
		organizationId: active.id,
		serverId: (serverId as Id<"servers"> | undefined) ?? null,
	});
	const isLoading = rows === undefined;
	const sandboxes = rows?.map(toSandbox);
	const kill = useMutation(api.live.sandboxes.kill);

	if (isLoading) {
		return (
			<div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
				Loading...
			</div>
		);
	}

	if (!sandboxes || sandboxes.length === 0) {
		return (
			<div className="flex min-h-[40vh] w-full flex-col items-center justify-center gap-2">
				<Box className="size-8 text-muted-foreground" />
				<span className="font-medium text-muted-foreground">
					No sandboxes on this server yet. Create one from the UI or through the
					API.
				</span>
			</div>
		);
	}

	return (
		<div className="rounded-lg border overflow-x-auto">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Name</TableHead>
						<TableHead>Image</TableHead>
						<TableHead>Status</TableHead>
						<TableHead>CPU / RAM</TableHead>
						<TableHead>Expires</TableHead>
						<TableHead>Created</TableHead>
						<TableHead className="text-right">Actions</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{sandboxes.map((sandbox) => (
						<TableRow key={sandbox.sandboxId}>
							<TableCell className="font-medium">
								<Link
									href={`/servers/${serverId ?? "local"}/sandboxes/${sandbox.sandboxId}`}
									className="hover:underline"
								>
									{sandbox.name}
								</Link>
							</TableCell>
							<TableCell className="font-mono text-xs">
								{sandbox.image}
							</TableCell>
							<TableCell>
								<SandboxStatusBadge status={sandbox.status} />
							</TableCell>
							<TableCell className="text-sm">
								{sandbox.cpu} vCPU / {sandbox.memoryMb} MB
							</TableCell>
							<TableCell className="text-sm text-muted-foreground">
								{formatExpiresIn(sandbox.expiresAt, sandbox.status)}
							</TableCell>
							<TableCell className="text-sm">
								<DateTooltip date={sandbox.createdAt} />
							</TableCell>
							<TableCell className="text-right">
								{sandbox.status === "running" && permissions.sandbox.create && (
									<DialogAction
										title="Kill sandbox"
										description={`The container for "${sandbox.name}" will be stopped and removed.`}
										onClick={async () => {
											await kill({ sandboxId: sandbox._id })
												.then(() => {
													toast.success("Sandbox killed");
												})
												.catch((error) =>
													toast.error(
														`Error killing the sandbox: ${errorMessage(error)}`,
													),
												);
										}}
									>
										<Button variant="ghost" size="icon">
											<Trash2 className="size-4 text-destructive" />
										</Button>
									</DialogAction>
								)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
};
