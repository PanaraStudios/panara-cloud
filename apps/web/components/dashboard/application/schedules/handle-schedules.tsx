"use client";

import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import {
	CheckIcon,
	ChevronsUpDown,
	DatabaseZap,
	PenBoxIcon,
	PlusIcon,
	RefreshCw,
} from "lucide-react";
import { useEffect, useState } from "react";
import { type Control, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { FormFooter } from "@/components/service-settings/form-footer";
import { FieldGrid } from "@/components/settings/form-kit";
import { CodeEditor } from "@/components/shared/code-editor";
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
import type { CacheType } from "../domains/handle-domain";
import { FormError } from "../form-kit";
import { getTimezoneLabel, TIMEZONES } from "./timezones";
import { useComposeServices } from "./use-compose-services";

export const commonCronExpressions = [
	{ label: "Every minute", value: "* * * * *" },
	{ label: "Every hour", value: "0 * * * *" },
	{ label: "Every day at midnight", value: "0 0 * * *" },
	{ label: "Every Sunday at midnight", value: "0 0 * * 0" },
	{ label: "Every month on the 1st at midnight", value: "0 0 1 * *" },
	{ label: "Every 15 minutes", value: "*/15 * * * *" },
	{ label: "Every weekday at midnight", value: "0 0 * * 1-5" },
	{ label: "Custom", value: "custom" },
];

const formSchema = z
	.object({
		name: z.string().min(1, "Name is required"),
		description: z.string().optional(),
		cronExpression: z.string().min(1, "Cron expression is required"),
		shellType: z.enum(["bash", "sh"]).default("bash"),
		command: z.string(),
		enabled: z.boolean().default(true),
		serviceName: z.string(),
		scheduleType: z.enum(["application", "compose", "server", "panel"]),
		script: z.string(),
		timezone: z.string().optional(),
	})
	.superRefine((data, ctx) => {
		if (data.scheduleType === "compose" && !data.serviceName) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Service name is required",
				path: ["serviceName"],
			});
		}

		if (
			(data.scheduleType === "panel" || data.scheduleType === "server") &&
			!data.script
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Script is required",
				path: ["script"],
			});
		}

		if (
			(data.scheduleType === "application" ||
				data.scheduleType === "compose") &&
			!data.command
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Command is required",
				path: ["command"],
			});
		}
	});

const SCHEDULE_TYPES = {
	application: "application",
	compose: "compose",
	server: "server",
	panel: "panel",
} as const;

interface Props {
	/** Renders the form as a page instead of a dialog; called when it closes. */
	onDone?: () => void;
	id?: string;
	scheduleId?: string;
	scheduleType?: "application" | "compose" | "server" | "panel";
}

export const ScheduleFormField = ({
	name,
	formControl,
}: {
	name: string;
	formControl: Control<any>;
}) => {
	const [selectedOption, setSelectedOption] = useState("");

	return (
		<FormField
			control={formControl}
			name={name}
			render={({ field }) => (
				<FormItem className="space-y-2">
					<FormLabel>Schedule</FormLabel>
					<div className="flex flex-col gap-2">
						<Select
							names="schedule"
							value={selectedOption}
							onValueChange={(value) => {
								setSelectedOption(value);
								field.onChange(value === "custom" ? "" : value);
							}}
						>
							<FormControl>
								<SelectTrigger className="w-full">
									<SelectValue placeholder="Pick a schedule" />
								</SelectTrigger>
							</FormControl>
							<SelectContent>
								{commonCronExpressions.map((expr) => (
									<SelectItem key={expr.value} value={expr.value}>
										{expr.label}
										{expr.value !== "custom" && ` (${expr.value})`}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<div className="relative">
							<FormControl>
								<Input
									placeholder="0 0 * * *"
									className="font-mono text-[13px]"
									{...field}
									onChange={(e) => {
										const value = e.target.value;
										const commonExpression = commonCronExpressions.find(
											(expression) => expression.value === value,
										);
										if (commonExpression) {
											setSelectedOption(commonExpression.value);
										} else {
											setSelectedOption("custom");
										}
										field.onChange(e);
									}}
								/>
							</FormControl>
						</div>
					</div>
					<FormDescription>
						Cron format: minute hour day month weekday.
					</FormDescription>
					<FormMessage />
				</FormItem>
			)}
		/>
	);
};

export const HandleSchedules = ({
	id,
	scheduleId,
	scheduleType,
	onDone,
}: Props) => {
	const [isOpenState, setIsOpenState] = useState(false);
	const isOpen = onDone ? true : isOpenState;
	const setIsOpen = (open: boolean) => {
		setIsOpenState(open);
		if (!open) onDone?.();
	};
	const [cacheType, setCacheType] = useState<CacheType>("cache");
	const { active } = useOrganization();
	const form = useForm({
		resolver: standardSchemaResolver(formSchema),
		defaultValues: {
			name: "",
			description: "",
			cronExpression: "",
			shellType: "bash",
			command: "",
			enabled: true,
			serviceName: "",
			scheduleType: scheduleType || "application",
			script: "",
			timezone: undefined,
		},
	});

	const scheduleTypeForm = form.watch("scheduleType");

	const row = useQuery(
		api.platform.schedules.get,
		scheduleId && isOpen
			? { scheduleId: scheduleId as Id<"schedules"> }
			: "skip",
	);
	const schedule = row
		? {
				...row,
				serviceName:
					row.target.kind === "compose" ? row.target.serviceName : undefined,
				scheduleType: SCHEDULE_TYPES[row.target.kind],
			}
		: undefined;

	const {
		data: services,
		isFetching: isLoadingServices,
		error: errorServices,
		refetch: refetchServices,
	} = useComposeServices(id, cacheType, isOpen && scheduleType === "compose");

	useEffect(() => {
		if (scheduleId && schedule) {
			form.reset({
				name: schedule.name,
				description: schedule.description || "",
				cronExpression: schedule.cronExpression,
				shellType: schedule.shellType,
				command: schedule.command,
				enabled: schedule.enabled,
				serviceName: schedule.serviceName || "",
				scheduleType: schedule.scheduleType,
				script: schedule.script || "",
				timezone: schedule.timezone || undefined,
			});
		}
	}, [form, row, scheduleId]);

	const createSchedule = useMutation(api.platform.schedules.create);
	const updateSchedule = useMutation(api.platform.schedules.update);
	const [isPending, setIsPending] = useState(false);

	const onSubmit = async (values: z.output<typeof formSchema>) => {
		if (!id && !scheduleId) return;
		const isHost = scheduleType === "server" || scheduleType === "panel";
		const fields = {
			name: values.name,
			description: values.description || undefined,
			cronExpression: values.cronExpression,
			timezone: values.timezone || undefined,
			shellType: values.shellType,
			command: isHost ? "" : values.command,
			script: isHost ? values.script : undefined,
			enabled: values.enabled,
		};
		const target =
			scheduleType === "compose"
				? {
						kind: "compose" as const,
						composeId: id || "",
						serviceName: values.serviceName,
					}
				: scheduleType === "server"
					? { kind: "server" as const, serverId: (id || "") as Id<"servers"> }
					: scheduleType === "panel"
						? { kind: "panel" as const }
						: { kind: "application" as const, applicationId: id || "" };

		setIsPending(true);
		await (scheduleId
			? updateSchedule({
					scheduleId: scheduleId as Id<"schedules">,
					...fields,
					...(scheduleType === "compose"
						? { serviceName: values.serviceName }
						: {}),
				})
			: createSchedule({ organizationId: active.id, target, ...fields })
		)
			.then(() => {
				toast.success(
					`Schedule ${scheduleId ? "updated" : "created"} successfully`,
				);
				setIsOpen(false);
			})
			.catch((error) => {
				toast.error(errorMessage(error) || "An unknown error occurred");
			})
			.finally(() => setIsPending(false));
	};

	const body = (
		<>
			<Form {...form}>
				<form
					method="post"
					onSubmit={form.handleSubmit(onSubmit)}
					className="grid w-full gap-4"
				>
					{scheduleTypeForm === "compose" && (
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
															Cache: If you previously deployed this compose, it
															will read the services from the last
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
						</div>
					)}

					<FieldGrid>
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Task name</FormLabel>
									<FormControl>
										<Input placeholder="Daily database backup" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="description"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Description</FormLabel>
									<FormControl>
										<Input
											placeholder="Backs up the database every day at midnight"
											{...field}
										/>
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
							name="timezone"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Timezone</FormLabel>
									<Popover>
										<PopoverTrigger render={<FormControl />}>
											<Button
												variant="outline"
												className={cn(
													"h-9 w-full justify-between font-normal",
													!field.value && "text-muted-foreground",
												)}
											>
												{getTimezoneLabel(field.value)}
												<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
											</Button>
										</PopoverTrigger>
										<PopoverContent
											className="w-[var(--anchor-width)] min-w-72 p-0"
											align="start"
										>
											<Command>
												<CommandInput
													placeholder="Search timezone..."
													className="h-9"
												/>
												<CommandList>
													<CommandEmpty>No timezone found.</CommandEmpty>
													<ScrollArea className="h-72">
														{Object.entries(TIMEZONES).map(
															([region, zones]) => (
																<CommandGroup key={region} heading={region}>
																	{zones.map((tz) => (
																		<CommandItem
																			key={tz.value}
																			value={`${region} ${tz.label} ${tz.value}`}
																			onSelect={() => {
																				field.onChange(tz.value);
																			}}
																		>
																			{tz.value}
																			<CheckIcon
																				className={cn(
																					"ml-auto h-4 w-4",
																					field.value === tz.value
																						? "opacity-100"
																						: "opacity-0",
																				)}
																			/>
																		</CommandItem>
																	))}
																</CommandGroup>
															),
														)}
													</ScrollArea>
												</CommandList>
											</Command>
										</PopoverContent>
									</Popover>
									<FormMessage />
								</FormItem>
							)}
						/>
						{(scheduleTypeForm === "application" ||
							scheduleTypeForm === "compose") && (
							<FormField
								control={form.control}
								name="shellType"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel>Shell type</FormLabel>
										<Select
											onValueChange={field.onChange}
											value={field.value ?? null}
										>
											<FormControl>
												<SelectTrigger className="w-full">
													<SelectValue placeholder="Select shell type" />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												<SelectItem value="bash">Bash</SelectItem>
												<SelectItem value="sh">Sh</SelectItem>
											</SelectContent>
										</Select>
										<FormMessage />
									</FormItem>
								)}
							/>
						)}
					</FieldGrid>

					{(scheduleTypeForm === "application" ||
						scheduleTypeForm === "compose") && (
						<>
							<FormField
								control={form.control}
								name="command"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel>Command</FormLabel>
										<FormControl>
											<Input
												placeholder="npm run backup"
												className="font-mono text-[13px]"
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						</>
					)}

					{(scheduleTypeForm === "panel" || scheduleTypeForm === "server") && (
						<FormField
							control={form.control}
							name="script"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Script</FormLabel>
									<FormControl>
										<FormControl>
											<CodeEditor
												language="shell"
												placeholder={`# This is a comment
echo "Hello, world!"
`}
												className="h-96 font-mono"
												{...field}
											/>
										</FormControl>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					)}

					<FormField
						control={form.control}
						name="enabled"
						render={({ field }) => (
							<FormItem className="flex flex-row items-center justify-between gap-6 space-y-0">
								<div className="min-w-0 space-y-1">
									<FormLabel>Enabled</FormLabel>
									<FormDescription>
										A disabled schedule keeps its settings and does not run.
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

					{onDone ? (
						<FormFooter page onCancel={onDone}>
							<Button type="submit" isLoading={isPending}>
								{scheduleId ? "Save" : "Add schedule"}
							</Button>
						</FormFooter>
					) : (
						<DialogFooter>
							<Button type="submit" isLoading={isPending}>
								{scheduleId ? "Save" : "Add schedule"}
							</Button>
						</DialogFooter>
					)}
				</form>
			</Form>
		</>
	);
	if (onDone) return <div className="flex w-full flex-col gap-6">{body}</div>;

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger
				render={
					(scheduleId ? (
						<Button variant="ghost" size="icon" aria-label="Edit schedule">
							<PenBoxIcon className="size-3.5 text-muted-foreground" />
						</Button>
					) : (
						<Button>
							<PlusIcon data-icon="inline-start" />
							Add schedule
						</Button>
					)) as React.ReactElement
				}
			/>
			<DialogContent
				className={cn(
					"flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg",
					scheduleTypeForm === "panel" || scheduleTypeForm === "server"
						? "sm:max-w-2xl"
						: "sm:max-w-lg",
				)}
			>
				<DialogHeader>
					<DialogTitle>
						{scheduleId ? "Edit schedule" : "Add schedule"}
					</DialogTitle>
					<DialogDescription>
						Runs a command on a cron schedule.
					</DialogDescription>
				</DialogHeader>
				{body}
			</DialogContent>
		</Dialog>
	);
};
