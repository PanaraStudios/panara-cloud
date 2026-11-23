"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import copy from "copy-to-clipboard";
import debounce from "lodash/debounce";
import { CheckIcon, ChevronsUpDown, Copy, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
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
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { useRouter } from "@/lib/router";
import { cn } from "@/lib/utils";
import { formatBytes } from "../../database/backups/restore-backup";
import {
	useBackupFiles,
	type VolumeBackupServiceType,
	volumeOwner,
} from "./use-volume-owner";

interface Props {
	id: string;
	type: VolumeBackupServiceType;
	serverId?: string;
	trigger?: React.ReactNode;
}

const RestoreBackupSchema = z.object({
	destinationId: z.string().min(1, {
		message: "Destination is required",
	}),
	backupFile: z.string().min(1, {
		message: "Backup file is required",
	}),
	volumeName: z.string().min(1, {
		message: "Volume name is required",
	}),
});

export const RestoreVolumeBackups = ({
	id,
	type,
	serverId,
	trigger,
}: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");

	const { active } = useOrganization();
	const destinationRows = useQuery(
		api.databases.destinations.list,
		isOpen ? { organizationId: active.id } : "skip",
	);
	const destinations = (destinationRows ?? []).map((destination) => ({
		destinationId: destination._id as string,
		name: destination.name,
	}));

	const form = useForm({
		defaultValues: {
			destinationId: "",
			backupFile: "",
			volumeName: "",
		},
		resolver: zodResolver(RestoreBackupSchema),
	});

	const destinationId = form.watch("destinationId");
	const volumeName = form.watch("volumeName");
	const backupFile = form.watch("backupFile");

	const debouncedSetSearch = debounce((value: string) => {
		setDebouncedSearchTerm(value);
	}, 350);

	const handleSearchChange = (value: string) => {
		setSearch(value);
		debouncedSetSearch(value);
	};

	const { data: files, isPending } = useBackupFiles(
		destinationId,
		debouncedSearchTerm,
		serverId,
		isOpen,
	);

	const router = useRouter();
	const [jobId, setJobId] = useState<Id<"jobs"> | null>(null);
	const job = useQuery(api.jobs.get, jobId ? { jobId } : "skip");
	const isDeploying =
		jobId !== null && (job?.status === "queued" || job?.status === "running");

	const restore = useMutation(api.databases.volumeBackups.restore);
	const [isStarting, setIsStarting] = useState(false);

	useEffect(() => {
		if (job?.status === "failed") {
			toast.error(job.error ?? "Restore failed");
		} else if (job?.status === "succeeded") {
			toast.success("Restore completed successfully!");
		}
	}, [job?.status, job?.error]);

	const onSubmit = async () => {
		setIsStarting(true);
		await restore({
			owner: volumeOwner(type, id),
			destinationId: destinationId as Id<"destinations">,
			volumeName,
			backupFile,
		})
			.then((newJobId) => {
				setJobId(newJobId);
				setIsOpen(false);
				router.push(`/activity/jobs/${newJobId}`);
			})
			.catch((error) => {
				toast.error(errorMessage(error));
			})
			.finally(() => setIsStarting(false));
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger
				render={
					(trigger ?? (
						<Button variant="outline">
							<RotateCcw data-icon="inline-start" />
							Restore volume backup
						</Button>
					)) as React.ReactElement
				}
			/>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Restore volume backup</DialogTitle>
					<DialogDescription>
						Pick a destination and a backup file. The volume must not be in use
						by another container.
					</DialogDescription>
				</DialogHeader>

				<Form {...form}>
					<form
						method="post"
						id="hook-form-restore-backup"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<FormField
							control={form.control}
							name="destinationId"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Destination</FormLabel>
									<Popover>
										<PopoverTrigger render={<FormControl />}>
											<Button
												variant="outline"
												className={cn(
													"h-9 w-full justify-between font-normal",
													!field.value && "text-muted-foreground",
												)}
											>
												{field.value
													? destinations.find(
															(d) => d.destinationId === field.value,
														)?.name
													: "Select destination"}
												<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
											</Button>
										</PopoverTrigger>
										<PopoverContent
											className="w-[var(--anchor-width)] p-0"
											align="start"
										>
											<Command>
												<CommandInput
													placeholder="Search destinations..."
													className="h-9"
												/>
												<CommandList className="max-h-none">
													<CommandEmpty>No destinations found.</CommandEmpty>
													<ScrollArea className="h-64">
														<CommandGroup>
															{destinations.map((destination) => (
																<CommandItem
																	value={destination.destinationId}
																	keywords={[destination.name]}
																	key={destination.destinationId}
																	onSelect={() => {
																		form.setValue(
																			"destinationId",
																			destination.destinationId,
																		);
																	}}
																>
																	{destination.name}
																	<CheckIcon
																		className={cn(
																			"ml-auto h-4 w-4",
																			destination.destinationId === field.value
																				? "opacity-100"
																				: "opacity-0",
																		)}
																	/>
																</CommandItem>
															))}
														</CommandGroup>
													</ScrollArea>
												</CommandList>
											</Command>
										</PopoverContent>
									</Popover>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="backupFile"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel className="flex items-center">
										Backup file
										{field.value && (
											<Badge variant="outline" className="truncate w-52">
												{field.value}
												<Copy
													className="ml-2 size-4 cursor-pointer"
													onClick={(e) => {
														e.stopPropagation();
														e.preventDefault();
														copy(field.value);
														toast.success("Backup file copied to clipboard");
													}}
												/>
											</Badge>
										)}
									</FormLabel>
									<Popover modal>
										<PopoverTrigger render={<FormControl />}>
											<Button
												variant="outline"
												className={cn(
													"h-9 w-full justify-between font-normal",
													!field.value && "text-muted-foreground",
												)}
											>
												<span className="truncate text-left flex-1 w-52">
													{field.value || "Search and select a backup file"}
												</span>
												<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
											</Button>
										</PopoverTrigger>
										<PopoverContent
											className="w-[var(--anchor-width)] p-0"
											align="start"
										>
											<Command>
												<CommandInput
													placeholder="Search backup files..."
													value={search}
													onValueChange={handleSearchChange}
													className="h-9"
												/>
												<CommandList className="max-h-none">
													{isPending ? (
														<div className="py-6 text-center text-sm">
															Loading backup files...
														</div>
													) : files.length === 0 && search ? (
														<div className="py-6 text-center text-sm text-muted-foreground">
															No backup files found for "{search}"
														</div>
													) : files.length === 0 ? (
														<div className="py-6 text-center text-sm text-muted-foreground">
															No backup files available
														</div>
													) : (
														<ScrollArea className="h-64">
															<CommandGroup>
																{files?.map((file) => (
																	<CommandItem
																		value={file.Path}
																		key={file.Path}
																		onSelect={() => {
																			form.setValue("backupFile", file.Path);
																			if (file.IsDir) {
																				setSearch(`${file.Path}/`);
																				setDebouncedSearchTerm(`${file.Path}/`);
																			} else {
																				setSearch(file.Path);
																				setDebouncedSearchTerm(file.Path);
																			}
																		}}
																	>
																		<div className="flex w-full flex-col gap-1">
																			<div className="flex w-full justify-between">
																				<span className="font-medium">
																					{file.Path}
																				</span>

																				<CheckIcon
																					className={cn(
																						"ml-auto h-4 w-4",
																						file.Path === field.value
																							? "opacity-100"
																							: "opacity-0",
																					)}
																				/>
																			</div>
																			<div className="flex items-center gap-4 text-xs text-muted-foreground">
																				<span>
																					Size: {formatBytes(file.Size)}
																				</span>
																				{file.IsDir && <span>Directory</span>}
																				{file.Hashes?.MD5 && (
																					<span>MD5: {file.Hashes.MD5}</span>
																				)}
																			</div>
																		</div>
																	</CommandItem>
																))}
															</CommandGroup>
														</ScrollArea>
													)}
												</CommandList>
											</Command>
										</PopoverContent>
									</Popover>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="volumeName"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Volume name</FormLabel>
									<FormControl>
										<Input
											placeholder="my-volume"
											className="font-mono text-[13px]"
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<DialogFooter>
							<Button
								isLoading={isDeploying || isStarting}
								form="hook-form-restore-backup"
								type="submit"
							>
								Restore
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
