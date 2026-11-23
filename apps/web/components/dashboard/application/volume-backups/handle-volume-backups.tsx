"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { DatabaseZap, PenBoxIcon, PlusCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
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
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import type { CacheType } from "../domains/handle-domain";
import { FormError } from "../form-kit";
import { ScheduleFormField } from "../schedules/handle-schedules";
import { useComposeServices } from "../schedules/use-compose-services";
import {
	useComposeMounts,
	type VolumeBackupServiceType,
	volumeOwner,
} from "./use-volume-owner";

const formSchema = z
	.object({
		name: z.string().min(1, "Name is required"),
		cronExpression: z.string().min(1, "Cron expression is required"),
		volumeName: z
			.string()
			.min(1, "Volume name is required")
			.regex(
				/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
				"Invalid volume name. Use letters, numbers, '._-' and start with a letter/number.",
			),
		prefix: z.string(),
		keepLatestCount: z.coerce
			.number()
			.int()
			.gte(1, "Must be at least 1")
			.optional()
			.nullable(),
		turnOff: z.boolean().default(false),
		enabled: z.boolean().default(true),
		serviceType: z.enum([
			"application",
			"compose",
			"postgres",
			"mariadb",
			"mongo",
			"mysql",
			"redis",
			"libsql",
		]),
		serviceName: z.string(),
		destinationId: z.string().min(1, "Destination required"),
	})
	.superRefine((data, ctx) => {
		if (data.serviceType === "compose" && !data.serviceName) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Service name is required",
				path: ["serviceName"],
			});
		}

		if (data.serviceType === "compose" && !data.serviceName) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Service name is required",
				path: ["serviceName"],
			});
		}
	});

interface Props {
	id?: string;
	volumeBackupId?: string;
	volumeBackupType?: VolumeBackupServiceType;
	// Replaces the default trigger button.
	trigger?: React.ReactElement;
}

export const HandleVolumeBackups = ({
	id,
	volumeBackupId,
	trigger,
	volumeBackupType,
}: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const [cacheType, setCacheType] = useState<CacheType>("cache");
	const [keepLatestCountInput, setKeepLatestCountInput] = useState("");

	const { active } = useOrganization();
	const permissions = usePermissions();
	const form = useForm({
		resolver: zodResolver(formSchema),
		defaultValues: {
			name: "",
			cronExpression: "",
			volumeName: "",
			prefix: "",
			keepLatestCount: undefined,
			turnOff: false,
			enabled: true,
			serviceName: "",
			serviceType: volumeBackupType,
		},
	});

	const serviceTypeForm = volumeBackupType;
	const destinationRows = useQuery(
		api.databases.destinations.list,
		isOpen ? { organizationId: active.id } : "skip",
	);
	const destinations = destinationRows?.map((destination) => ({
		destinationId: destination._id as string,
		name: destination.name,
	}));
	const row = useQuery(
		api.databases.volumeBackups.get,
		volumeBackupId && isOpen
			? { volumeBackupId: volumeBackupId as Id<"volumeBackups"> }
			: "skip",
	);
	const volumeBackup = row
		? { ...row, serviceType: volumeBackupType }
		: undefined;

	const applicationMounts = useQuery(
		api.applications.mounts.list,
		isOpen &&
			permissions.volume.read &&
			id &&
			volumeBackupType === "application"
			? { applicationId: id as Id<"applications"> }
			: "skip",
	);
	const mounts = applicationMounts?.flatMap((mount) =>
		mount.type === "volume" ? [{ Name: mount.volumeName }] : [],
	);

	const {
		data: services,
		isFetching: isLoadingServices,
		error: errorServices,
		refetch: refetchServices,
	} = useComposeServices(
		id,
		cacheType,
		isOpen && volumeBackupType === "compose",
	);

	const serviceName = form.watch("serviceName");

	const mountsByService = useComposeMounts(
		id,
		serviceName,
		isOpen && volumeBackupType === "compose",
	);

	useEffect(() => {
		if (volumeBackupId && volumeBackup) {
			form.reset({
				name: volumeBackup.name,
				cronExpression: volumeBackup.cronExpression,
				volumeName: volumeBackup.volumeName || "",
				prefix: volumeBackup.prefix,
				keepLatestCount: volumeBackup.keepLatestCount || undefined,
				turnOff: volumeBackup.turnOff,
				enabled: volumeBackup.enabled || false,
				serviceName: volumeBackup.serviceName || "",
				destinationId: volumeBackup.destinationId,
				serviceType: volumeBackup.serviceType,
			});
			setKeepLatestCountInput(
				volumeBackup.keepLatestCount !== null &&
					volumeBackup.keepLatestCount !== undefined
					? String(volumeBackup.keepLatestCount)
					: "",
			);
		}
	}, [form, row, volumeBackupId]);

	const createVolumeBackup = useMutation(api.databases.volumeBackups.create);
	const updateVolumeBackup = useMutation(api.databases.volumeBackups.update);
	const [isPending, setIsPending] = useState(false);

	const onSubmit = async (values: z.infer<typeof formSchema>) => {
		if (!id && !volumeBackupId) return;

		const preparedKeepLatestCount =
			keepLatestCountInput === "" ? null : (values.keepLatestCount ?? null);

		const fields = {
			name: values.name,
			volumeName: values.volumeName,
			prefix: values.prefix,
			serviceName: values.serviceName || undefined,
			turnOff: values.turnOff,
			cronExpression: values.cronExpression,
			keepLatestCount: preparedKeepLatestCount ?? undefined,
			enabled: values.enabled,
			destinationId: values.destinationId as Id<"destinations">,
		};
		setIsPending(true);
		await (volumeBackupId
			? updateVolumeBackup({
					volumeBackupId: volumeBackupId as Id<"volumeBackups">,
					...fields,
				})
			: createVolumeBackup({
					owner: volumeOwner(volumeBackupType ?? "application", id || ""),
					...fields,
				})
		)
			.then(() => {
				toast.success(
					`Volume backup ${volumeBackupId ? "updated" : "created"} successfully`,
				);
				setIsOpen(false);
			})
			.catch((error) => {
				toast.error(errorMessage(error) || "An unknown error occurred");
			})
			.finally(() => setIsPending(false));
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger
				render={
					(trigger ??
						(volumeBackupId ? (
							<Button
								variant="ghost"
								size="icon"
								aria-label="Edit volume backup"
							>
								<PenBoxIcon className="size-3.5 text-muted-foreground" />
							</Button>
						) : (
							<Button>
								<PlusCircle data-icon="inline-start" />
								Add volume backup
							</Button>
						))) as React.ReactElement
				}
			/>
			<DialogContent
				className={cn(
					"flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg",
					volumeBackupType === "compose" || volumeBackupType === "application"
						? "sm:max-w-2xl"
						: "sm:max-w-lg",
				)}
			>
				<DialogHeader>
					<DialogTitle>
						{volumeBackupId ? "Edit volume backup" : "Add volume backup"}
					</DialogTitle>
					<DialogDescription>
						Copies a Docker volume to a destination on a schedule.
					</DialogDescription>
				</DialogHeader>
				<Form {...form}>
					<form
						method="post"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input placeholder="Daily volume backup" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<ScheduleFormField
							name="cronExpression"
							formControl={form.control}
						/>

						<FormField
							control={form.control}
							name="destinationId"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Destination</FormLabel>
									<Select
										names="storage"
										onValueChange={field.onChange}
										value={field.value ?? null}
									>
										<FormControl>
											<SelectTrigger className="w-full">
												<SelectValue placeholder="Select a destination" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											{destinations?.map((destination) => (
												<SelectItem
													key={destination.destinationId}
													value={destination.destinationId}
												>
													{destination.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<FormMessage />
								</FormItem>
							)}
						/>
						{serviceTypeForm === "compose" && (
							<>
								<div className="flex flex-col w-full gap-4">
									{errorServices && (
										<FormError
											title="Couldn't load the stack's services."
											detail={errorServices?.message}
										/>
									)}
									<FormField
										control={form.control}
										name="serviceName"
										render={({ field }) => (
											<FormItem className="space-y-2">
												<FormLabel>Service name</FormLabel>
												<div className="flex gap-2">
													<Select
														names="service"
														onValueChange={field.onChange}
														value={field.value || null}
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
															<SelectItem value="none" disabled>
																Empty
															</SelectItem>
														</SelectContent>
													</Select>
													<TooltipProvider delay={0}>
														<Tooltip>
															<TooltipTrigger
																render={
																	<Button
																		variant="outline"
																		size="icon-lg"
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
																		variant="outline"
																		size="icon-lg"
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
								{mountsByService && mountsByService.length > 0 && (
									<FormField
										control={form.control}
										name="volumeName"
										render={({ field }) => (
											<FormItem className="space-y-2">
												<FormLabel>Volumes</FormLabel>
												<Select
													names="volume"
													onValueChange={field.onChange}
													value={field.value || null}
												>
													<FormControl>
														<SelectTrigger className="w-full">
															<SelectValue placeholder="Select a volume name" />
														</SelectTrigger>
													</FormControl>
													<SelectContent>
														{mountsByService?.map((volume) => (
															<SelectItem
																key={volume.Name}
																value={volume.Name || ""}
															>
																{volume.Name}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
												<FormDescription>
													Not listed? Type the name below.
												</FormDescription>
												<FormMessage />
											</FormItem>
										)}
									/>
								)}
							</>
						)}
						{serviceTypeForm === "application" && (
							<FormField
								control={form.control}
								name="volumeName"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel>Volumes</FormLabel>
										<Select
											names="volume"
											onValueChange={field.onChange}
											value={field.value || null}
										>
											<FormControl>
												<SelectTrigger className="w-full">
													<SelectValue placeholder="Select a volume name" />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												{mounts && mounts.length > 0 ? (
													mounts.map((mount) => (
														<SelectItem
															key={mount.Name}
															value={mount.Name || ""}
														>
															{mount.Name}
														</SelectItem>
													))
												) : (
													<SelectItem value="none" disabled>
														No volumes found
													</SelectItem>
												)}
											</SelectContent>
										</Select>
										<FormDescription>
											Not listed? Type the name below.
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
						)}

						<FormField
							control={form.control}
							name="volumeName"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Volume name</FormLabel>
									<FormControl>
										<Input placeholder="my-volume-name" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="prefix"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Backup prefix</FormLabel>
									<FormControl>
										<Input placeholder="backup-" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="keepLatestCount"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Keep latest backups</FormLabel>
									<FormControl>
										<Input
											{...field}
											type="number"
											min={1}
											autoComplete="off"
											placeholder="Leave empty to keep all"
											value={keepLatestCountInput}
											onChange={(e) => {
												const raw = e.target.value;
												setKeepLatestCountInput(raw);
												if (raw === "") {
													field.onChange(undefined);
												} else if (/^\d+$/.test(raw)) {
													field.onChange(Number(raw));
												}
											}}
										/>
									</FormControl>
									<FormDescription>
										How many recent backups to keep. Empty means no cleanup.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="turnOff"
							render={({ field }) => (
								<FormItem className="flex flex-row items-center justify-between gap-6 space-y-0">
									<div className="min-w-0 space-y-1">
										<FormLabel>Stop the container during backup</FormLabel>
										<FormDescription>
											Prevents corrupted files. The service is down while the
											backup runs.
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

						<FormField
							control={form.control}
							name="enabled"
							render={({ field }) => (
								<FormItem className="flex flex-row items-center justify-between gap-6 space-y-0">
									<FormLabel>Enabled</FormLabel>
									<FormControl>
										<Switch
											checked={field.value}
											onCheckedChange={field.onChange}
										/>
									</FormControl>
								</FormItem>
							)}
						/>

						<DialogFooter>
							<Button type="submit" isLoading={isPending}>
								{volumeBackupId ? "Save" : "Add volume backup"}
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
