"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import { HelpCircle, Loader2, LockIcon, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { PageHeader } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import {
	hostId,
	useHostSnapshot,
	useWaitForJob,
} from "../../servers/host-jobs";
import { AddNode } from "./add-node";
import { ShowNodeData } from "./show-node-data";

interface Props {
	serverId?: string;
}

type SwarmNodes = {
	swarm: string;
	nodes: {
		id: string;
		hostname: string;
		role: string;
		availability: string;
		status: string;
		addr: string | null;
		managerStatus: string;
		engineVersion: string;
		architecture: string;
		nanoCpus: number;
		memoryBytes: number;
		createdAt?: string | null;
		tlsStatus?: string;
	}[];
};

export const ShowNodes = ({ serverId }: Props) => {
	const { active } = useOrganization();
	const {
		data: swarm,
		isLoading: isPending,
		refresh,
	} = useHostSnapshot<SwarmNodes>(serverId, "swarmNodes");
	const data = swarm?.nodes;
	const registry = useQuery(api.sources.registries.list, {
		organizationId: active.id,
	});
	const permissions = usePermissions();

	const runDocker = useMutation(api.infra.docker.run);
	const waitForJob = useWaitForJob();
	const deleteNode = async ({ nodeId }: { nodeId: string }) =>
		waitForJob(
			await runDocker({
				serverId: hostId(serverId),
				action: { type: "nodeRemove", nodeId },
			}),
		);

	const haveAtLeastOneRegistry = !!(registry && registry?.length > 0);
	return (
		<div className="w-full">
			<div className="flex w-full flex-col gap-6">
				<PageHeader title="Nodes" description="Machines in this swarm.">
					{haveAtLeastOneRegistry && permissions?.server.create && (
						<AddNode serverId={serverId} />
					)}
				</PageHeader>
				<div className="space-y-2 min-h-[35vh]">
					{isPending ? (
						<div className="flex items-center justify-center w-full h-[40vh]">
							<Loader2 className="size-8 animate-spin text-muted-foreground" />
						</div>
					) : haveAtLeastOneRegistry ? (
						<div className="grid md:grid-cols-1 gap-4">
							<Table>
								<TableCaption>A list of your managers / workers.</TableCaption>
								<TableHeader>
									<TableRow>
										<TableHead className="text-left">Hostname</TableHead>
										<TableHead className="text-right">Status</TableHead>
										<TableHead className="text-right">Role</TableHead>
										<TableHead className="text-right">Availability</TableHead>
										<TableHead className="text-right">Engine Version</TableHead>
										<TableHead className="text-right">Created</TableHead>

										<TableHead className="text-right">Actions</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data?.map((node) => {
										const isManager = node.role === "manager";
										return (
											<TableRow key={node.id}>
												<TableCell className="text-left">
													{node.hostname}
												</TableCell>
												<TableCell className="text-right">
													{node.status}
												</TableCell>
												<TableCell className="text-right">
													<Badge variant={isManager ? "default" : "secondary"}>
														{node.role}
													</Badge>
												</TableCell>
												<TableCell className="text-right">
													{node.availability}
												</TableCell>

												<TableCell className="text-right">
													{node.engineVersion}
												</TableCell>

												<TableCell className="text-right">
													{node.createdAt ? (
														<DateTooltip
															date={node.createdAt}
															className="text-sm"
														>
															Created{" "}
														</DateTooltip>
													) : (
														<span className="text-sm">-</span>
													)}
												</TableCell>
												<TableCell className="text-right flex justify-end">
													<DropdownMenu>
														<DropdownMenuTrigger
															render={
																<Button
																	variant="ghost"
																	className="h-8 w-8 p-0"
																/>
															}
														>
															<span className="sr-only">Open menu</span>
															<MoreHorizontal className="h-4 w-4" />
														</DropdownMenuTrigger>
														<DropdownMenuContent align="end">
															<DropdownMenuGroup>
																<DropdownMenuLabel>Actions</DropdownMenuLabel>
															</DropdownMenuGroup>
															<ShowNodeData
																data={node}
																serverId={serverId}
																nodeId={node.id}
															/>
															{node.managerStatus !== "Leader" &&
																permissions?.server.delete && (
																	<DialogAction
																		title="Delete Node"
																		description="Are you sure you want to delete this node from the cluster?"
																		type="destructive"
																		onClick={async () => {
																			await deleteNode({
																				nodeId: node.id,
																			})
																				.then(() => {
																					refresh();
																					toast.success(
																						"Node deleted successfully",
																					);
																				})
																				.catch((error) => {
																					toast.error(
																						errorMessage(error) ||
																							"Error deleting node",
																					);
																				});
																		}}
																	>
																		<DropdownMenuItem closeOnClick={false}>
																			Delete
																		</DropdownMenuItem>
																	</DialogAction>
																)}
														</DropdownMenuContent>
													</DropdownMenu>
												</TableCell>
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						</div>
					) : (
						<div className="flex flex-col items-center gap-3">
							<LockIcon className="size-8 text-muted-foreground" />
							<div className="flex flex-row gap-2">
								<span className="text-base text-muted-foreground ">
									To add nodes to your cluster, you need to configure at least
									one registry.
								</span>
								<TooltipProvider delay={0}>
									<Tooltip>
										<TooltipTrigger className="self-center">
											<HelpCircle className="size-5 text-muted-foreground " />
										</TooltipTrigger>
										<TooltipContent>
											Nodes need a registry to pull images from.
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
							</div>

							<ul className="list-disc list-inside text-sm text-muted-foreground border p-4 rounded-lg flex flex-col gap-1.5 mt-2.5">
								<li>
									<strong>Docker Registry:</strong> Use custom registries like
									Docker Hub, DigitalOcean Registry, etc.
								</li>
							</ul>
						</div>
					)}
				</div>
			</div>
		</div>
	);
};
