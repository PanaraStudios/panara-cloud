"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import copy from "copy-to-clipboard";
import debounce from "lodash/debounce";
import {
	CheckIcon,
	ChevronsUpDown,
	Copy,
	DatabaseZap,
	RefreshCw,
	RotateCcw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { DrawerLogs } from "@/components/shared/drawer-logs";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { cn } from "@/lib/utils";
import { type JobId, useJobLogs } from "../../shared/job-logs";
import { type OpId, useBackupFiles } from "./use-backup-files";
import { useComposeServices } from "./use-compose-services";

type DatabaseType =
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "libsql"
	| "web-server";

interface Props {
	id: string;
	databaseType?: DatabaseType;
	serverId?: string | null;
	backupType?: "database" | "compose";
	trigger?: React.ReactNode;
}

const RestoreBackupSchema = z
	.object({
		destinationId: z.string().min(1, {
			message: "Destination is required",
		}),
		backupFile: z.string().min(1, {
			message: "Backup file is required",
		}),
		databaseName: z.string().min(1, {
			message: "Database name is required",
		}),
		databaseType: z
			.enum(["postgres", "mariadb", "mysql", "mongo", "web-server", "libsql"])
			.optional(),
		backupType: z.enum(["database", "compose"]).default("database"),
		metadata: z
			.object({
				postgres: z
					.object({
						databaseUser: z.string(),
					})
					.optional(),
				mariadb: z
					.object({
						databaseUser: z.string(),
						databasePassword: z.string(),
					})
					.optional(),
				mongo: z
					.object({
						databaseUser: z.string(),
						databasePassword: z.string(),
					})
					.optional(),
				mysql: z
					.object({
						databaseRootPassword: z.string(),
					})
					.optional(),
				serviceName: z.string().optional(),
			})
			.optional(),
	})
	.superRefine((data, ctx) => {
		if (data.backupType === "compose" && !data.databaseType) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Database type is required for compose backups",
				path: ["databaseType"],
			});
		}

		if (data.backupType === "compose" && !data.metadata?.serviceName) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Service name is required for compose backups",
				path: ["metadata", "serviceName"],
			});
		}

		if (data.backupType === "compose" && data.databaseType) {
			if (data.databaseType === "postgres") {
				if (!data.metadata?.postgres?.databaseUser) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: "Database user is required for PostgreSQL",
						path: ["metadata", "postgres", "databaseUser"],
					});
				}
			} else if (data.databaseType === "mariadb") {
				if (!data.metadata?.mariadb?.databaseUser) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: "Database user is required for MariaDB",
						path: ["metadata", "mariadb", "databaseUser"],
					});
				}
				if (!data.metadata?.mariadb?.databasePassword) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: "Database password is required for MariaDB",
						path: ["metadata", "mariadb", "databasePassword"],
					});
				}
			} else if (data.databaseType === "mongo") {
				if (!data.metadata?.mongo?.databaseUser) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: "Database user is required for MongoDB",
						path: ["metadata", "mongo", "databaseUser"],
					});
				}
				if (!data.metadata?.mongo?.databasePassword) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: "Database password is required for MongoDB",
						path: ["metadata", "mongo", "databasePassword"],
					});
				}
			} else if (data.databaseType === "mysql") {
				if (!data.metadata?.mysql?.databaseRootPassword) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: "Root password is required for MySQL",
						path: ["metadata", "mysql", "databaseRootPassword"],
					});
				}
			}
		}
	});

export const formatBytes = (bytes: number): string => {
	if (bytes === 0) return "0 Bytes";
	const k = 1024;
	const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
};

export const RestoreBackup = ({
	id,
	databaseType,
	serverId,
	backupType = "database",
	trigger,
}: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");

	const { active } = useOrganization();
	const destinationRows = useQuery(api.databases.destinations.list, {
		organizationId: active.id,
	});
	const destinations = (destinationRows ?? []).map((destination) => ({
		...destination,
		destinationId: destination._id as string,
	}));

	const form = useForm({
		defaultValues: {
			destinationId: "",
			backupFile: "",
			databaseName:
				databaseType === "web-server"
					? "panara-cloud"
					: databaseType === "libsql"
						? "iku.db"
						: "",
			databaseType:
				backupType === "compose" ? ("postgres" as DatabaseType) : databaseType,
			backupType: backupType,
			metadata: {},
		},
		resolver: zodResolver(RestoreBackupSchema),
	});

	const destinationId = form.watch("destinationId");
	const currentDatabaseType = form.watch("databaseType");

	const debouncedSetSearch = debounce((value: string) => {
		setDebouncedSearchTerm(value);
	}, 350);

	const handleSearchChange = (value: string) => {
		setSearch(value);
		debouncedSetSearch(value);
	};

	const listFiles = useMutation(api.databases.destinations.listFiles);
	const [filesOpId, setFilesOpId] = useState<OpId | null>(null);
	useEffect(() => {
		if (!isOpen || !destinationId) {
			setFilesOpId(null);
			return;
		}
		let current = true;
		listFiles({
			destinationId: destinationId as Id<"destinations">,
			search: debouncedSearchTerm,
			serverId: serverId ? (serverId as Id<"servers">) : undefined,
		})
			.then((result) => {
				if (current) setFilesOpId(result.opId);
			})
			.catch((error) => toast.error(errorMessage(error)));
		return () => {
			current = false;
		};
	}, [isOpen, destinationId, debouncedSearchTerm, serverId, listFiles]);
	const listing = useBackupFiles(filesOpId);
	const files = listing.files ?? [];
	const isPending = listing.isPending && !listing.isError;

	const [isDrawerOpen, setIsDrawerOpen] = useState(false);
	const [jobId, setJobId] = useState<JobId | null>(null);
	const { logs: filteredLogs, isFinished } = useJobLogs(jobId);
	const isDeploying = jobId !== null && !isFinished;

	const restoreBackup = useMutation(api.databases.backups.restore);
	const restorePanelBackup = useMutation(api.databases.panelBackups.restore);
	const restoreCompose = useAction(api.databases.backups.restoreCompose);

	const onSubmit = async (data: z.infer<typeof RestoreBackupSchema>) => {
		if (backupType === "compose" && !data.databaseType) {
			toast.error("Please select a database type");
			return;
		}
		try {
			const type = data.databaseType ?? databaseType;
			let started: JobId;
			if (type === "web-server") {
				started = await restorePanelBackup({
					destinationId: data.destinationId as Id<"destinations">,
					backupFile: data.backupFile,
				});
			} else if (backupType === "compose") {
				if (!type) return;
				const credentials =
					type === "postgres"
						? { databaseUser: data.metadata?.postgres?.databaseUser }
						: type === "mariadb"
							? {
									databaseUser: data.metadata?.mariadb?.databaseUser,
									databasePassword: data.metadata?.mariadb?.databasePassword,
								}
							: type === "mongo"
								? {
										databaseUser: data.metadata?.mongo?.databaseUser,
										databasePassword: data.metadata?.mongo?.databasePassword,
									}
								: type === "mysql"
									? {
											databasePassword:
												data.metadata?.mysql?.databaseRootPassword,
										}
									: {};
				started = await restoreCompose({
					composeId: id as Id<"compose">,
					serviceName: data.metadata?.serviceName ?? "",
					destinationId: data.destinationId as Id<"destinations">,
					backupFile: data.backupFile,
					databaseName: data.databaseName,
					databaseType: type,
					...credentials,
				});
			} else {
				if (!type) return;
				started = await restoreBackup({
					owner: { kind: "database", id },
					destinationId: data.destinationId as Id<"destinations">,
					backupFile: data.backupFile,
					databaseName: data.databaseName,
					databaseType: type,
				});
			}
			setJobId(started);
			setIsDrawerOpen(true);
		} catch (error) {
			toast.error("Error restoring the backup", {
				description: errorMessage(error),
			});
		}
	};

	const [cacheType, setCacheType] = useState<"fetch" | "cache">("cache");
	const composeServices = useComposeServices(
		id,
		isOpen && backupType === "compose",
	);
	const services = composeServices.services ?? [];
	const isLoadingServices = composeServices.isLoading;
	const refetchServices = () => composeServices.load(cacheType);
	const loadedCacheType = useRef(cacheType);
	useEffect(() => {
		if (loadedCacheType.current === cacheType) return;
		loadedCacheType.current = cacheType;
		void composeServices.load(cacheType);
	}, [cacheType, composeServices.load]);

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger
				render={
					(trigger ?? (
						<Button variant="outline">
							<RotateCcw className="mr-2 size-4" />
							Restore Backup
						</Button>
					)) as React.ReactElement
				}
			/>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle className="flex items-center">
						<RotateCcw className="mr-2 size-4" />
						Restore Backup
					</DialogTitle>
					<DialogDescription>
						Select a destination and search for backup files
					</DialogDescription>
				</DialogHeader>

				<Form {...form}>
					<form
						id="hook-form-restore-backup"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<FormField
							control={form.control}
							name="destinationId"
							render={({ field }) => (
								<FormItem className="">
									<FormLabel>Destination</FormLabel>
									<Popover>
										<PopoverTrigger render={<FormControl />}>
											<Button
												variant="outline"
												className={cn(
													"w-full justify-between",
													!field.value && "text-muted-foreground",
												)}
											>
												{field.value
													? destinations.find(
															(d) => d.destinationId === field.value,
														)?.name
													: "Select Destination"}
												<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
											</Button>
										</PopoverTrigger>
										<PopoverContent className="p-0" align="start">
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
								<FormItem className="">
									<FormLabel className="flex items-center justify-between gap-2">
										<span className="shrink-0">Search Backup Files</span>
										{field.value && (
											<Badge variant="outline" className="min-w-0 max-w-[70%]">
												<span className="min-w-0 truncate">{field.value}</span>
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
													"w-full justify-between",
													!field.value && "text-muted-foreground",
												)}
											>
												<span className="min-w-0 flex-1 truncate text-left">
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
															<CommandGroup className="w-full">
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
																			<div className="flex w-full items-start justify-between gap-2">
																				<span className="min-w-0 flex-1 break-all font-medium">
																					{file.Path}
																				</span>

																				<CheckIcon
																					className={cn(
																						"mt-0.5 h-4 w-4 shrink-0",
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
																				{file.IsDir && (
																					<span className="text-blue-500">
																						Directory
																					</span>
																				)}
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
							name="databaseName"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Database Name</FormLabel>
									<FormControl>
										<Input
											placeholder="Enter database name"
											{...field}
											disabled={
												databaseType === "web-server" ||
												databaseType === "libsql"
											}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						{backupType === "compose" && (
							<>
								<FormField
									control={form.control}
									name="databaseType"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Database Type</FormLabel>
											<Select
												value={field.value}
												onValueChange={(value: DatabaseType) => {
													field.onChange(value);
													form.setValue("metadata", {
														serviceName:
															form.getValues("metadata.serviceName") ?? "",
													});
												}}
											>
												<SelectTrigger className="w-full">
													<SelectValue placeholder="Select database type" />
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="postgres">PostgreSQL</SelectItem>
													<SelectItem value="mariadb">MariaDB</SelectItem>
													<SelectItem value="mongo">MongoDB</SelectItem>
													<SelectItem value="mysql">MySQL</SelectItem>
												</SelectContent>
											</Select>
											<FormMessage />
										</FormItem>
									)}
								/>

								<FormField
									control={form.control}
									name="metadata.serviceName"
									render={({ field }) => (
										<FormItem className="w-full">
											<FormLabel>Service Name</FormLabel>
											<div className="flex gap-2">
												<Select
													onValueChange={field.onChange}
													value={field.value ?? ""}
												>
													<FormControl>
														<SelectTrigger className="w-full">
															<SelectValue placeholder="Select a service name" />
														</SelectTrigger>
													</FormControl>

													<SelectContent>
														{services?.map((service, index) => (
															<SelectItem
																value={service}
																key={`${service}-${index}`}
															>
																{service}
															</SelectItem>
														))}
														{(!services || services.length === 0) && (
															<SelectItem value="none" disabled>
																Empty
															</SelectItem>
														)}
													</SelectContent>
												</Select>
												<TooltipProvider delay={0}>
													<Tooltip>
														<TooltipTrigger
															render={
																<Button
																	variant="secondary"
																	type="button"
																	isLoading={isLoadingServices}
																	onClick={() => {
																		if (cacheType === "fetch") {
																			refetchServices();
																		} else {
																			setCacheType("fetch");
																		}
																	}}
																/>
															}
														>
															<RefreshCw className="size-4 text-muted-foreground" />
														</TooltipTrigger>
														<TooltipContent
															side="left"
															sideOffset={5}
															className="max-w-40"
														>
															<p>
																Fetch: Will clone the repository and load the
																services
															</p>
														</TooltipContent>
													</Tooltip>
												</TooltipProvider>
												<TooltipProvider delay={0}>
													<Tooltip>
														<TooltipTrigger
															render={
																<Button
																	variant="secondary"
																	type="button"
																	isLoading={isLoadingServices}
																	onClick={() => {
																		if (cacheType === "cache") {
																			refetchServices();
																		} else {
																			setCacheType("cache");
																		}
																	}}
																/>
															}
														>
															<DatabaseZap className="size-4 text-muted-foreground" />
														</TooltipTrigger>
														<TooltipContent
															side="left"
															sideOffset={5}
															className="max-w-40"
														>
															<p>
																Cache: If you previously deployed this compose,
																it will read the services from the last
																deployment/fetch from the repository
															</p>
														</TooltipContent>
													</Tooltip>
												</TooltipProvider>
											</div>

											<FormMessage />
										</FormItem>
									)}
								/>

								{currentDatabaseType === "postgres" && (
									<FormField
										control={form.control}
										name="metadata.postgres.databaseUser"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Database User</FormLabel>
												<FormControl>
													<Input placeholder="Enter database user" {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
								)}

								{currentDatabaseType === "mariadb" && (
									<>
										<FormField
											control={form.control}
											name="metadata.mariadb.databaseUser"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Database User</FormLabel>
													<FormControl>
														<Input
															placeholder="Enter database user"
															{...field}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="metadata.mariadb.databasePassword"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Database Password</FormLabel>
													<FormControl>
														<Input
															type="password"
															placeholder="Enter database password"
															{...field}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
									</>
								)}

								{currentDatabaseType === "mongo" && (
									<>
										<FormField
											control={form.control}
											name="metadata.mongo.databaseUser"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Database User</FormLabel>
													<FormControl>
														<Input
															placeholder="Enter database user"
															{...field}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="metadata.mongo.databasePassword"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Database Password</FormLabel>
													<FormControl>
														<Input
															type="password"
															placeholder="Enter database password"
															{...field}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
									</>
								)}

								{currentDatabaseType === "mysql" && (
									<FormField
										control={form.control}
										name="metadata.mysql.databaseRootPassword"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Root Password</FormLabel>
												<FormControl>
													<Input
														type="password"
														placeholder="Enter root password"
														{...field}
													/>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
								)}
							</>
						)}

						<DialogFooter>
							<Button
								isLoading={isDeploying}
								form="hook-form-restore-backup"
								type="submit"
								// disabled={
								// 	!form.watch("backupFile") ||
								// 	(backupType === "compose" && !form.watch("databaseType"))
								// }
							>
								Restore
							</Button>
						</DialogFooter>
					</form>
				</Form>

				<DrawerLogs
					isOpen={isDrawerOpen}
					onClose={() => {
						setIsDrawerOpen(false);
						setJobId(null);
					}}
					filteredLogs={filteredLogs}
				/>
			</DialogContent>
		</Dialog>
	);
};
