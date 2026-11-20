"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import {
	CheckIcon,
	ChevronsUpDown,
	DatabaseZap,
	PenBoxIcon,
	PlusIcon,
	RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
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
	FormDescription,
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
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { cn } from "@/lib/utils";
import { ScheduleFormField } from "../../application/schedules/handle-schedules";
import { useComposeServices } from "./use-compose-services";

type CacheType = "cache" | "fetch";

type DatabaseType =
	| "postgres"
	| "mariadb"
	| "mysql"
	| "mongo"
	| "web-server"
	| "libsql";

// Compose credentials are write-only: an existing backup keeps its stored
// password unless a new one is entered.
const makeSchema = (requirePasswords: boolean) =>
	z
		.object({
			destinationId: z.string().min(1, "Destination required"),
			schedule: z.string().min(1, "Schedule (Cron) required"),
			prefix: z.string().min(1, "Prefix required"),
			customName: z
				.string()
				.trim()
				.max(100, "Custom name must be 100 characters or less")
				.regex(
					/^([a-zA-Z0-9][a-zA-Z0-9._-]*)?$/,
					"Must start with a letter or number; only letters, numbers, dots, hyphens and underscores are allowed",
				)
				.optional(),
			enabled: z.boolean(),
			includeEncryptionKey: z.boolean(),
			database: z.string().min(1, "Database required"),
			keepLatestCount: z.coerce.number().optional(),
			serviceName: z.string().nullable(),
			databaseType: z
				.enum(["postgres", "mariadb", "mysql", "mongo", "web-server", "libsql"])
				.optional(),
			backupType: z.enum(["database", "compose"]),
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

			if (data.backupType === "compose" && !data.serviceName) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Service name is required for compose backups",
					path: ["serviceName"],
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
					if (requirePasswords && !data.metadata?.mariadb?.databasePassword) {
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
					if (requirePasswords && !data.metadata?.mongo?.databasePassword) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							message: "Database password is required for MongoDB",
							path: ["metadata", "mongo", "databasePassword"],
						});
					}
				} else if (data.databaseType === "mysql") {
					if (requirePasswords && !data.metadata?.mysql?.databaseRootPassword) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							message: "Root password is required for MySQL",
							path: ["metadata", "mysql", "databaseRootPassword"],
						});
					}
				}
			}
		});

const Schema = makeSchema(true);

interface Props {
	id?: string;
	backupId?: string;
	databaseType?: DatabaseType;
	refetch?: () => void;
	backupType: "database" | "compose";
	label?: string;
}

export const HandleBackup = ({
	id,
	backupId,
	databaseType = "postgres",
	refetch,
	backupType = "database",
	label,
}: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const { active } = useOrganization();
	const isPanel = databaseType === "web-server";

	const destinations = useQuery(api.databases.destinations.list, {
		organizationId: active.id,
	});
	const isPending = destinations === undefined;
	const data = destinations?.map((destination) => ({
		...destination,
		destinationId: destination._id as string,
	}));
	const serviceBackup = useQuery(
		api.databases.backups.get,
		backupId && !isPanel
			? { backupId: backupId as Id<"databaseBackups"> }
			: "skip",
	);
	const panelBackups = useQuery(
		api.databases.panelBackups.list,
		backupId && isPanel ? {} : "skip",
	);
	const panelBackup = panelBackups?.find((row) => row._id === backupId);
	const backup = useMemo(
		() =>
			serviceBackup
				? {
						database: serviceBackup.database,
						destinationId: serviceBackup.destinationId as string,
						enabled: serviceBackup.enabled,
						includeEncryptionKey: true,
						prefix: serviceBackup.prefix,
						customName: serviceBackup.customName,
						schedule: serviceBackup.cronExpression,
						keepLatestCount: serviceBackup.keepLatestCount,
						serviceName: serviceBackup.serviceName,
						databaseType: serviceBackup.databaseType as DatabaseType,
						backupType:
							serviceBackup.owner.kind === "compose"
								? ("compose" as const)
								: ("database" as const),
						composeId:
							serviceBackup.owner.kind === "compose"
								? serviceBackup.owner.id
								: undefined,
						metadata: {
							[serviceBackup.databaseType]: {
								databaseUser: serviceBackup.databaseUser ?? "",
								databasePassword: "",
								databaseRootPassword: "",
							},
						},
					}
				: panelBackup
					? {
							database: "panara-cloud",
							destinationId: panelBackup.destinationId as string,
							enabled: panelBackup.enabled,
							includeEncryptionKey: panelBackup.includeEncryptionKey ?? false,
							prefix: panelBackup.prefix,
							customName: undefined,
							schedule: panelBackup.cronExpression,
							keepLatestCount: panelBackup.keepLatestCount,
							serviceName: undefined,
							databaseType: "web-server" as DatabaseType,
							backupType: "database" as const,
							composeId: undefined,
							metadata: {},
						}
					: undefined,
		[serviceBackup],
	);

	const createServiceBackup = useMutation(api.databases.backups.create);
	const updateServiceBackup = useMutation(api.databases.backups.update);
	const setCredentials = useAction(api.databases.backups.setCredentials);
	const createPanelBackup = useMutation(api.databases.panelBackups.create);
	const updatePanelBackup = useMutation(api.databases.panelBackups.update);
	const [isCreatingPostgresBackup, setIsSaving] = useState(false);

	const form = useForm({
		defaultValues: {
			database:
				databaseType === "web-server"
					? "panara-cloud"
					: databaseType === "libsql"
						? "iku.db"
						: "",
			destinationId: "",
			enabled: true,
			includeEncryptionKey: true,
			prefix: "/",
			customName: "",
			schedule: "",
			keepLatestCount: undefined,
			serviceName: null,
			databaseType: backupType === "compose" ? undefined : databaseType,
			backupType: backupType,
			metadata: {},
		},
		resolver: zodResolver(makeSchema(!backupId)),
	});

	const [cacheType, setCacheType] = useState<CacheType>("cache");
	const composeServices = useComposeServices(
		backup?.composeId ?? id,
		isOpen && backupType === "compose",
	);
	const services = composeServices.services;
	const isLoadingServices = composeServices.isLoading;
	const errorServices = composeServices.error;
	const refetchServices = () => composeServices.load(cacheType);
	const loadedCacheType = useRef(cacheType);
	useEffect(() => {
		if (loadedCacheType.current === cacheType) return;
		loadedCacheType.current = cacheType;
		void composeServices.load(cacheType);
	}, [cacheType, composeServices.load]);

	useEffect(() => {
		form.reset({
			database: backup?.database
				? backup?.database
				: databaseType === "web-server"
					? "panara-cloud"
					: databaseType === "libsql"
						? "iku.db"
						: "",
			destinationId: backup?.destinationId ?? "",
			enabled: backup?.enabled ?? true,
			includeEncryptionKey: backup?.includeEncryptionKey ?? true,
			prefix: backup?.prefix ?? "/",
			customName: backup?.customName ?? "",
			schedule: backup?.schedule ?? "",
			keepLatestCount: backup?.keepLatestCount ?? undefined,
			serviceName: backup?.serviceName ?? null,
			databaseType: backup?.databaseType ?? databaseType,
			backupType: backup?.backupType ?? backupType,
			metadata: backup?.metadata ?? {},
		});
	}, [form, form.reset, backupId, backup]);

	const onSubmit = async (data: z.infer<typeof Schema>) => {
		const type = data.databaseType || databaseType;
		const keepLatestCount = data.keepLatestCount || undefined;
		setIsSaving(true);
		try {
			if (type === "web-server") {
				const fields = {
					destinationId: data.destinationId as Id<"destinations">,
					cronExpression: data.schedule,
					enabled: data.enabled,
					prefix: data.prefix,
					keepLatestCount,
					includeEncryptionKey: data.includeEncryptionKey,
				};
				if (backupId) {
					await updatePanelBackup({
						panelBackupId: backupId as Id<"panelBackups">,
						...fields,
					});
				} else {
					await createPanelBackup(fields);
				}
			} else {
				const credentials =
					type === "postgres"
						? { databaseUser: data.metadata?.postgres?.databaseUser }
						: type === "mariadb"
							? {
									databaseUser: data.metadata?.mariadb?.databaseUser,
									password: data.metadata?.mariadb?.databasePassword,
								}
							: type === "mongo"
								? {
										databaseUser: data.metadata?.mongo?.databaseUser,
										password: data.metadata?.mongo?.databasePassword,
									}
								: type === "mysql"
									? {
											databaseUser: "root",
											password: data.metadata?.mysql?.databaseRootPassword,
										}
									: {};
				const isCompose = (backup?.backupType ?? backupType) === "compose";
				const fields = {
					databaseType: type,
					database: data.database,
					destinationId: data.destinationId as Id<"destinations">,
					cronExpression: data.schedule,
					enabled: data.enabled,
					prefix: data.prefix,
					customName: data.customName || undefined,
					keepLatestCount,
					serviceName: isCompose ? (data.serviceName ?? undefined) : undefined,
					databaseUser: isCompose ? credentials.databaseUser : undefined,
				};
				const savedId = backupId
					? backupId
					: await createServiceBackup({
							owner: {
								kind: backupType === "compose" ? "compose" : "database",
								id: id ?? "",
							},
							...fields,
						});
				if (backupId) {
					await updateServiceBackup({
						backupId: backupId as Id<"databaseBackups">,
						...fields,
					});
				}
				if (isCompose && "password" in credentials && credentials.password) {
					await setCredentials({
						backupId: savedId as Id<"databaseBackups">,
						password: credentials.password,
					});
				}
			}
			toast.success(`Backup ${backupId ? "Updated" : "Created"}`);
			refetch?.();
			setIsOpen(false);
		} catch (error) {
			toast.error(`Error ${backupId ? "updating" : "creating"} a backup`, {
				description: errorMessage(error),
			});
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger
				render={
					(backupId ? (
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label="Edit schedule"
							className="text-muted-foreground"
						>
							<PenBoxIcon />
						</Button>
					) : (
						<Button
							variant={label ? "outline" : "default"}
							size={label ? "sm" : "default"}
						>
							<PlusIcon data-icon="inline-start" />
							{label ?? (backupId ? "Update Backup" : "Create Backup")}
						</Button>
					)) as React.ReactElement
				}
			/>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						{backupId ? "Update Backup" : "Create Backup"}
					</DialogTitle>
					<DialogDescription>
						{backupId ? "Update a backup" : "Add a new backup"}
					</DialogDescription>
				</DialogHeader>

				<Form {...form}>
					<form
						id="hook-form-add-backup"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<div className="grid grid-cols-1 gap-4">
							{errorServices && (
								<AlertBlock type="warning" className="wrap-anywhere">
									{errorServices?.message}
								</AlertBlock>
							)}
							{backupType === "compose" && (
								<FormField
									control={form.control}
									name="databaseType"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Database Type</FormLabel>
											<Select
												value={field.value}
												onValueChange={(value) => {
													field.onChange(value as DatabaseType);
													form.setValue("metadata", {});
												}}
											>
												<SelectTrigger className="w-full w-full">
													<SelectValue placeholder="Select a database type" />
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="postgres">PostgreSQL</SelectItem>
													<SelectItem value="mariadb">MariaDB</SelectItem>
													<SelectItem value="mysql">MySQL</SelectItem>
													<SelectItem value="mongo">MongoDB</SelectItem>
												</SelectContent>
											</Select>
											<FormMessage />
										</FormItem>
									)}
								/>
							)}
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
													{isPending
														? "Loading...."
														: field.value
															? data?.find(
																	(destination) =>
																		destination.destinationId === field.value,
																)?.name
															: "Select Destination"}

													<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
												</Button>
											</PopoverTrigger>
											<PopoverContent
												className="w-(--anchor-width) min-w-56 p-0"
												align="start"
											>
												<Command>
													<CommandInput
														placeholder="Search Destination..."
														className="h-9"
													/>
													<CommandList className="max-h-none">
														{isPending && (
															<span className="py-6 text-center text-sm">
																Loading Destinations....
															</span>
														)}
														<CommandEmpty>No destinations found.</CommandEmpty>
														<ScrollArea className="h-64">
															<CommandGroup>
																{data?.map((destination) => (
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
																				destination.destinationId ===
																					field.value
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
							{backupType === "compose" && (
								<div className="flex flex-row items-end w-full gap-4">
									<FormField
										control={form.control}
										name="serviceName"
										render={({ field }) => (
											<FormItem className="w-full">
												<FormLabel>Service Name</FormLabel>
												<div className="flex gap-2">
													<Select
														onValueChange={field.onChange}
														value={field.value || undefined}
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
																	Cache: If you previously deployed this
																	compose, it will read the services from the
																	last deployment/fetch from the repository
																</p>
															</TooltipContent>
														</Tooltip>
													</TooltipProvider>
												</div>

												<FormMessage />
											</FormItem>
										)}
									/>
								</div>
							)}
							<FormField
								control={form.control}
								name="database"
								render={({ field }) => {
									return (
										<FormItem>
											<FormLabel>Database</FormLabel>
											<FormControl>
												<Input
													disabled={
														databaseType === "web-server" ||
														databaseType === "libsql"
													}
													placeholder={"panara-cloud"}
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									);
								}}
							/>

							<ScheduleFormField name="schedule" formControl={form.control} />

							<FormField
								control={form.control}
								name="prefix"
								render={({ field }) => {
									return (
										<FormItem>
											<FormLabel>Prefix Destination</FormLabel>
											<FormControl>
												<Input placeholder={"panara-cloud/"} {...field} />
											</FormControl>
											<FormDescription>
												Use if you want to back up in a specific path of your
												destination/bucket
											</FormDescription>

											<FormMessage />
										</FormItem>
									);
								}}
							/>
							<FormField
								control={form.control}
								name="customName"
								render={({ field }) => {
									return (
										<FormItem>
											<FormLabel>Custom File Name</FormLabel>
											<FormControl>
												<Input placeholder={"my-backup"} {...field} />
											</FormControl>
											<FormDescription>
												Optional. Prepended to the automatically generated
												timestamp, e.g.
												"my-backup-2026-08-03T20-58-22-123Z.sql.gz". Only
												letters, numbers, dots, hyphens and underscores are
												allowed. "Keep the latest" counts every backup in the
												same destination folder, regardless of its custom name.
											</FormDescription>
											<FormMessage />
										</FormItem>
									);
								}}
							/>
							<FormField
								control={form.control}
								name="keepLatestCount"
								render={({ field }) => {
									return (
										<FormItem>
											<FormLabel>Keep the latest</FormLabel>
											<FormControl>
												<Input
													type="number"
													placeholder={"keeps all the backups if left empty"}
													{...field}
													value={field.value as string}
												/>
											</FormControl>
											<FormDescription>
												Optional. If provided, only keeps the latest N backups
												in the cloud.
											</FormDescription>
											<FormMessage />
										</FormItem>
									);
								}}
							/>
							<FormField
								control={form.control}
								name="enabled"
								render={({ field }) => (
									<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 ">
										<div className="space-y-0.5">
											<FormLabel>Enabled</FormLabel>
											<FormDescription>
												Enable or disable the backup
											</FormDescription>
										</div>
										<FormControl>
											<Switch
												checked={field.value}
												onCheckedChange={field.onChange}
											/>
										</FormControl>
									</FormItem>
								)}
							/>
							{databaseType === "web-server" && (
								<FormField
									control={form.control}
									name="includeEncryptionKey"
									render={({ field }) => (
										<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 ">
											<div className="space-y-0.5">
												<FormLabel>Include secrets</FormLabel>
												<FormDescription>
													Stores the encryption key, auth secret and agent
													signing keys inside the backup so the panel can be
													restored on a new server. Anyone with access to the
													backup file can decrypt your secrets.
												</FormDescription>
											</div>
											<FormControl>
												<Switch
													checked={field.value}
													onCheckedChange={field.onChange}
												/>
											</FormControl>
										</FormItem>
									)}
								/>
							)}
							{backupType === "compose" && (
								<>
									{form.watch("databaseType") === "postgres" && (
										<FormField
											control={form.control}
											name="metadata.postgres.databaseUser"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Database User</FormLabel>
													<FormControl>
														<Input placeholder="postgres" {...field} />
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
									)}

									{form.watch("databaseType") === "mariadb" && (
										<>
											<FormField
												control={form.control}
												name="metadata.mariadb.databaseUser"
												render={({ field }) => (
													<FormItem>
														<FormLabel>Database User</FormLabel>
														<FormControl>
															<Input placeholder="mariadb" {...field} />
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
																placeholder="••••••••"
																{...field}
															/>
														</FormControl>
														<FormMessage />
													</FormItem>
												)}
											/>
										</>
									)}

									{form.watch("databaseType") === "mongo" && (
										<>
											<FormField
												control={form.control}
												name="metadata.mongo.databaseUser"
												render={({ field }) => (
													<FormItem>
														<FormLabel>Database User</FormLabel>
														<FormControl>
															<Input placeholder="mongo" {...field} />
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
																placeholder="••••••••"
																{...field}
															/>
														</FormControl>
														<FormMessage />
													</FormItem>
												)}
											/>
										</>
									)}

									{form.watch("databaseType") === "mysql" && (
										<FormField
											control={form.control}
											name="metadata.mysql.databaseRootPassword"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Root Password</FormLabel>
													<FormControl>
														<Input
															type="password"
															placeholder="••••••••"
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
						</div>
						<DialogFooter>
							<Button
								isLoading={isCreatingPostgresBackup}
								form="hook-form-add-backup"
								type="submit"
							>
								{backupId ? "Update" : "Create"}
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
