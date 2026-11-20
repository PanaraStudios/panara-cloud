"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { ArrowRightLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { DrawerLogs } from "@/components/shared/drawer-logs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { type JobId, useJobLogs } from "./job-logs";

const LOCAL_SERVER = "panara-cloud";

const transferSchema = z.object({
	targetServerId: z.string().min(1, { message: "Select a target server" }),
	removeSourceData: z.boolean(),
});

type TransferForm = z.infer<typeof transferSchema>;

export type ServiceType =
	| "application"
	| "compose"
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis"
	| "libsql";

interface Props {
	id: string;
	type: ServiceType;
	serverId?: string | null;
	/** Text trigger instead of the icon button (settings pages). */
	label?: string;
}

export const TransferService = ({ id, type, serverId, label }: Props) => {
	const { active } = useOrganization();
	const servers = useQuery(api.servers.list, { organizationId: active.id });
	const transferApplication = useMutation(api.applications.transfer.start);
	const transferCompose = useMutation(api.compose.transfer.start);
	const transferDatabase = useMutation(api.databases.transfer.start);
	const [isOpen, setIsOpen] = useState(false);
	const [isDrawerOpen, setIsDrawerOpen] = useState(false);
	const [isTransferring, setIsTransferring] = useState(false);
	const [jobId, setJobId] = useState<JobId | null>(null);
	const { logs, job } = useJobLogs(jobId);

	// Servers the panel can reach to deploy on.
	const targets = [
		...(serverId
			? [{ serverId: LOCAL_SERVER, name: "Panara Cloud Server" }]
			: []),
		...(servers ?? [])
			.filter(
				(server) =>
					server.sshKeyId &&
					server.serverType === "deploy" &&
					server._id !== serverId,
			)
			.map((server) => ({ serverId: server._id as string, name: server.name })),
	];

	const form = useForm<TransferForm>({
		defaultValues: { targetServerId: "", removeSourceData: false },
		resolver: zodResolver(transferSchema),
	});

	useEffect(() => {
		if (!isTransferring || !job) return;
		if (job.status === "succeeded") {
			setIsTransferring(false);
			toast.success("Service transferred successfully");
		} else if (job.status === "failed" || job.status === "cancelled") {
			setIsTransferring(false);
			toast.error("Transfer failed, check the logs");
		}
	}, [isTransferring, job]);

	const startTransfer = (request: {
		targetServerId: Id<"servers"> | undefined;
		removeSourceData: boolean;
	}) => {
		switch (type) {
			case "application":
				return transferApplication({
					applicationId: id as Id<"applications">,
					...request,
				});
			case "compose":
				return transferCompose({ composeId: id as Id<"compose">, ...request });
			default:
				return transferDatabase({
					databaseId: id as Id<"databases">,
					...request,
				});
		}
	};

	const onSubmit = async (values: TransferForm) => {
		setIsTransferring(true);
		try {
			const started = await startTransfer({
				targetServerId:
					values.targetServerId === LOCAL_SERVER
						? undefined
						: (values.targetServerId as Id<"servers">),
				removeSourceData: values.removeSourceData,
			});
			setJobId(started);
			setIsDrawerOpen(true);
			setIsOpen(false);
		} catch (error) {
			setIsTransferring(false);
			toast.error(errorMessage(error));
		}
	};

	return (
		<>
			<Dialog open={isOpen} onOpenChange={setIsOpen}>
				<DialogTrigger
					render={
						label ? (
							<Button variant="outline" isLoading={isTransferring} />
						) : (
							<Button
								variant="ghost"
								size="icon"
								className="group hover:bg-blue-500/10"
								isLoading={isTransferring}
							/>
						)
					}
				>
					{label ?? (
						<ArrowRightLeft className="size-4 text-primary group-hover:text-blue-500" />
					)}
				</DialogTrigger>
				<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Transfer to another server</DialogTitle>
						<DialogDescription>
							Moves this service with its volumes, bind mounts, file mounts and
							configuration to the selected server, then deploys it there.
						</DialogDescription>
					</DialogHeader>
					{targets.length === 0 ? (
						<AlertBlock type="info">
							There are no other servers available to transfer this service to.
						</AlertBlock>
					) : (
						<Form {...form}>
							<form
								onSubmit={form.handleSubmit(onSubmit)}
								id="hook-form-transfer-service"
								className="grid w-full gap-4"
							>
								<FormField
									control={form.control}
									name="targetServerId"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Target server</FormLabel>
											<Select
												onValueChange={field.onChange}
												defaultValue={field.value}
											>
												<FormControl>
													<SelectTrigger className="w-full">
														<SelectValue placeholder="Select a server" />
													</SelectTrigger>
												</FormControl>
												<SelectContent>
													{targets.map((server) => (
														<SelectItem
															key={server.serverId}
															value={server.serverId}
														>
															{server.name}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="removeSourceData"
									render={({ field }) => (
										<FormItem>
											<div className="flex items-center">
												<FormControl>
													<Checkbox
														checked={field.value}
														onCheckedChange={field.onChange}
													/>
												</FormControl>
												<FormLabel className="ml-2">
													Remove volumes from the source server after the
													transfer
												</FormLabel>
											</div>
											<FormMessage />
										</FormItem>
									)}
								/>
								<AlertBlock type="warning">
									<ul className="list-disc pl-4 space-y-1">
										<li>The service is stopped while its data is copied.</li>
										<li>
											Point your DNS records to the new server, certificates are
											issued again there.
										</li>
										<li>
											Networks that only exist on the current server are
											detached.
										</li>
										<li>
											Bind mount host paths are copied but never deleted from
											the source server.
										</li>
									</ul>
								</AlertBlock>
							</form>
						</Form>
					)}
					<DialogFooter>
						<Button variant="secondary" onClick={() => setIsOpen(false)}>
							Cancel
						</Button>
						{targets.length > 0 && (
							<Button
								isLoading={isTransferring}
								form="hook-form-transfer-service"
								type="submit"
							>
								Transfer
							</Button>
						)}
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<DrawerLogs
				isOpen={isDrawerOpen}
				onClose={() => setIsDrawerOpen(false)}
				filteredLogs={logs}
			/>
		</>
	);
};
