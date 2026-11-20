"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useQuery } from "convex/react";
import { AlertTriangle, Database, HelpCircle } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
	LibsqlIcon,
	MariadbIcon,
	MongodbIcon,
	MysqlIcon,
	PostgresqlIcon,
	RedisIcon,
} from "@/components/icons/data-tools-icons";
import { FormFooter } from "@/components/service-settings/form-footer";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { slugify } from "@/lib/slug";
import { APP_NAME_MESSAGE, APP_NAME_REGEX } from "@/utils/schema";

type DbType = z.infer<typeof mySchema>["type"];

const dockerImageDefaultPlaceholder: Record<DbType, string> = {
	mongo: "mongo:8",
	libsql: "ghcr.io/tursodatabase/libsql-server:v0.24.32",
	mariadb: "mariadb:11",
	mysql: "mysql:8",
	postgres: "postgres:18",
	redis: "redis:8",
};

const databasesUserDefaultPlaceholder: Record<
	Exclude<DbType, "redis">,
	string
> = {
	libsql: "libsql",
	mariadb: "mariadb",
	mongo: "mongo",
	mysql: "mysql",
	postgres: "postgres",
};

const baseDatabaseSchema = z.object({
	name: z.string().min(1, "Name required"),
	appName: z
		.string()
		.min(1, {
			message: "App name is required",
		})
		.regex(APP_NAME_REGEX, {
			message: APP_NAME_MESSAGE,
		}),
	databasePassword: z
		.string()
		.regex(/^[a-zA-Z0-9@#%^&*()_+\-=[\]{}|;:,.<>?~`]*$/, {
			message:
				"Password contains invalid characters. Please avoid: $ ! ' \" \\ / and space characters for database compatibility",
		}),
	dockerImage: z.string(),
	description: z.string().nullable(),
	serverId: z.string().nullable(),
});

const mySchema = z
	.discriminatedUnion("type", [
		z
			.object({
				type: z.literal("libsql"),
				dockerImage: z
					.string()
					.default("ghcr.io/tursodatabase/libsql-server:v0.24.32"),
				databaseUser: z.string().default("libsql"),
				sqldNode: z.enum(["primary", "replica"]).default("primary"),
				sqldPrimaryUrl: z.string().optional(),
				enableNamespaces: z.boolean().default(false),
			})
			.merge(baseDatabaseSchema),
		z
			.object({
				type: z.literal("mariadb"),
				dockerImage: z.string().default("mariadb:4"),
				databaseRootPassword: z
					.string()
					.regex(/^[a-zA-Z0-9@#%^&*()_+\-=[\]{}|;:,.<>?~`]*$/, {
						message:
							"Password contains invalid characters. Please avoid: $ ! ' \" \\ / and space characters for database compatibility",
					})
					.optional(),
				databaseUser: z.string().default("mariadb"),
				databaseName: z.string().default("mariadb"),
			})
			.merge(baseDatabaseSchema),
		z
			.object({
				type: z.literal("mongo"),
				databaseUser: z.string().default("mongo"),
				replicaSets: z.boolean().default(false),
			})
			.merge(baseDatabaseSchema),
		z
			.object({
				type: z.literal("mysql"),
				databaseRootPassword: z
					.string()
					.regex(/^[a-zA-Z0-9@#%^&*()_+\-=[\]{}|;:,.<>?~`]*$/, {
						message:
							"Password contains invalid characters. Please avoid: $ ! ' \" \\ / and space characters for database compatibility",
					})
					.optional(),
				databaseUser: z.string().default("mysql"),
				databaseName: z.string().default("mysql"),
			})
			.merge(baseDatabaseSchema),
		z
			.object({
				type: z.literal("postgres"),
				databaseName: z.string().default("postgres"),
				databaseUser: z.string().default("postgres"),
			})
			.merge(baseDatabaseSchema),
		z
			.object({
				type: z.literal("redis"),
			})
			.merge(baseDatabaseSchema),
	])
	.superRefine((data, ctx) => {
		if (data.type === "libsql") {
			if (data.sqldNode === "replica" && !data.sqldPrimaryUrl) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["sqldPrimaryUrl"],
					message: "sqldPrimaryUrl is required when sqldNode is 'replica'.",
				});
			}
			if (data.sqldNode !== "replica" && data.sqldPrimaryUrl) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["sqldPrimaryUrl"],
					message:
						"sqldPrimaryUrl should not be provided when sqldNode is not 'replica'.",
				});
			}
		}
	});

const databasesMap = {
	postgres: {
		icon: <PostgresqlIcon />,
		label: "PostgreSQL",
	},
	mongo: {
		icon: <MongodbIcon />,
		label: "MongoDB",
	},
	mariadb: {
		icon: <MariadbIcon />,
		label: "MariaDB",
	},
	mysql: {
		icon: <MysqlIcon />,
		label: "MySQL",
	},
	redis: {
		icon: <RedisIcon />,
		label: "Redis",
	},
	libsql: {
		icon: <LibsqlIcon className="size-10" />,
		label: "libSQL",
	},
};

type AddDatabase = z.infer<typeof mySchema>;

interface Props {
	/** Renders the form as a page instead of a dialog; called when it closes. */
	onDone?: () => void;
	environmentId: string;
	projectName?: string;
}

export const AddDatabase = ({ environmentId, projectName, onDone }: Props) => {
	const { active } = useOrganization();
	const [visibleState, setVisibleState] = useState(false);
	const visible = onDone ? true : visibleState;
	const setVisible = (open: boolean) => {
		setVisibleState(open);
		if (!open) onDone?.();
	};
	const slug = slugify(projectName);
	const showLocalOption = !useQuery(
		api.platform.deployTargets.remoteServersOnly,
		{},
	);
	const servers = useQuery(api.servers.list, {
		organizationId: active.id,
	})?.filter((server) => server.sshKeyId);
	const createDatabase = useAction(api.databases.databases.create);
	const [createError, setCreateError] = useState<string | null>(null);

	const hasServers = servers && servers.length > 0;
	const shouldShowServerDropdown = hasServers;

	const form = useForm({
		defaultValues: {
			type: "postgres",
			dockerImage: "",
			name: "",
			appName: `${slug}-`,
			databasePassword: "",
			description: "",
			databaseName: "",
			databaseUser: "",
			serverId: null,
		},
		resolver: zodResolver(mySchema),
	});
	const sqldNode = form.watch("sqldNode");
	const type = form.watch("type");

	const onSubmit = async (data: AddDatabase) => {
		const defaultDockerImage =
			data.dockerImage || dockerImageDefaultPlaceholder[data.type];

		let promise: Promise<unknown> | null = null;
		const commonParams = {
			engine: data.type,
			name: data.name,
			appName: data.appName,
			dockerImage: defaultDockerImage,
			serverId:
				!data.serverId || data.serverId === "local"
					? undefined
					: (data.serverId as Id<"servers">),
			environmentId: environmentId as Id<"environments">,
			description: data.description ?? undefined,
			databasePassword: data.databasePassword || undefined,
		};

		if (data.type === "libsql") {
			promise = createDatabase({
				...commonParams,
				sqldNode: data.sqldNode,
				sqldPrimaryUrl: data.sqldPrimaryUrl || undefined,
				enableNamespaces: data.enableNamespaces,
				databaseUser:
					data.databaseUser || databasesUserDefaultPlaceholder[data.type],
			});
		} else if (data.type === "mariadb") {
			promise = createDatabase({
				...commonParams,
				databaseRootPassword: data.databaseRootPassword || undefined,
				databaseName: data.databaseName || "mariadb",
				databaseUser:
					data.databaseUser || databasesUserDefaultPlaceholder[data.type],
			});
		} else if (data.type === "mongo") {
			promise = createDatabase({
				...commonParams,
				databaseUser:
					data.databaseUser || databasesUserDefaultPlaceholder[data.type],
				replicaSets: data.replicaSets,
			});
		} else if (data.type === "mysql") {
			promise = createDatabase({
				...commonParams,
				databaseName: data.databaseName || "mysql",
				databaseUser:
					data.databaseUser || databasesUserDefaultPlaceholder[data.type],
				databaseRootPassword: data.databaseRootPassword || undefined,
			});
		} else if (data.type === "postgres") {
			promise = createDatabase({
				...commonParams,
				databaseName: data.databaseName || "postgres",
				databaseUser:
					data.databaseUser || databasesUserDefaultPlaceholder[data.type],
			});
		} else if (data.type === "redis") {
			promise = createDatabase(commonParams);
		}

		if (promise) {
			setCreateError(null);
			await promise
				.then(() => {
					toast.success("Database created");
					form.reset({
						type: "postgres",
						dockerImage: "",
						name: "",
						appName: `${projectName}-`,
						databasePassword: "",
						description: "",
						databaseName: "",
						databaseUser: "",
					});
					setVisible(false);
				})
				.catch((error) => {
					setCreateError(errorMessage(error));
					toast.error("Error creating a database");
				});
		}
	};

	const body = (
		<>
			<Form {...form}>
				<form
					id="hook-form"
					onSubmit={form.handleSubmit(onSubmit)}
					className="grid w-full gap-8 "
				>
					<FormField
						control={form.control}
						defaultValue={form.control._defaultValues.type}
						name="type"
						render={({ field }) => (
							<FormItem className="space-y-3">
								<FormLabel className="text-muted-foreground">
									Select a database
								</FormLabel>
								<FormControl>
									<RadioGroup
										onValueChange={field.onChange}
										defaultValue={field.value}
										className="grid w-full grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4"
									>
										{Object.entries(databasesMap).map(([key, value]) => (
											<FormItem
												key={key}
												className="flex w-full items-center space-x-3 space-y-0"
											>
												<FormControl className="w-full">
													<div>
														<RadioGroupItem
															value={key}
															id={key}
															className="peer sr-only"
														/>
														<Label
															htmlFor={key}
															className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground peer-data-checked:border-primary has-data-checked:border-primary cursor-pointer"
														>
															{value.icon}
															{value.label}
														</Label>
													</div>
												</FormControl>
											</FormItem>
										))}
									</RadioGroup>
								</FormControl>
								<FormMessage />
								{createError && (
									<div className="flex flex-row gap-4 rounded-lg bg-red-50 p-2 dark:bg-red-950">
										<AlertTriangle className="text-red-600 dark:text-red-400" />
										<span className="text-sm text-red-600 dark:text-red-400">
											{createError}
										</span>
									</div>
								)}
							</FormItem>
						)}
					/>
					<div className="flex flex-col gap-4">
						<FormLabel className="text-lg font-semibold leading-none tracking-tight">
							Fill the next fields.
						</FormLabel>
						<div className="flex flex-col gap-2">
							<FormField
								control={form.control}
								name="name"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Name</FormLabel>
										<FormControl>
											<Input
												placeholder="Name"
												{...field}
												onChange={(e) => {
													const val = e.target.value || "";
													const serviceName = slugify(val.trim());
													form.setValue("appName", `${slug}-${serviceName}`);
													field.onChange(val);
												}}
											/>
										</FormControl>

										<FormMessage />
									</FormItem>
								)}
							/>
							{shouldShowServerDropdown && (
								<FormField
									control={form.control}
									name="serverId"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Select a Server</FormLabel>
											<Select
												onValueChange={field.onChange}
												defaultValue={
													field.value || (showLocalOption ? "local" : undefined)
												}
											>
												<SelectTrigger className="w-full">
													<SelectValue
														placeholder={
															showLocalOption
																? "Panara Cloud"
																: "Select a Server"
														}
													/>
												</SelectTrigger>
												<SelectContent>
													<SelectGroup>
														{showLocalOption && (
															<SelectItem value="local">
																<span className="flex items-center gap-2 justify-between w-full">
																	<span>Panara Cloud</span>
																	<span className="text-muted-foreground text-xs self-center">
																		Default
																	</span>
																</span>
															</SelectItem>
														)}
														{servers?.map((server) => (
															<SelectItem key={server._id} value={server._id}>
																{server.name}
															</SelectItem>
														))}
														<SelectLabel>
															Servers (
															{(servers?.length ?? 0) +
																(showLocalOption ? 1 : 0)}
															)
														</SelectLabel>
													</SelectGroup>
												</SelectContent>
											</Select>
											<FormMessage />
										</FormItem>
									)}
								/>
							)}
							<FormField
								control={form.control}
								name="appName"
								render={({ field }) => (
									<FormItem>
										<FormLabel className="flex items-center gap-2">
											App Name
											<TooltipProvider delay={0}>
												<Tooltip>
													<TooltipTrigger
														render={
															<HelpCircle className="size-4 text-muted-foreground" />
														}
													/>
													<TooltipContent side="right">
														<p>
															This will be the name of the Docker Swarm service
														</p>
													</TooltipContent>
												</Tooltip>
											</TooltipProvider>
										</FormLabel>
										<FormControl>
											<Input placeholder="my-app" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>

							<FormField
								control={form.control}
								name="description"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Description</FormLabel>
										<FormControl>
											<Textarea
												className="h-24"
												placeholder="Description"
												{...field}
												value={field.value || ""}
											/>
										</FormControl>

										<FormMessage />
									</FormItem>
								)}
							/>
							{(type === "mariadb" ||
								type === "mysql" ||
								type === "postgres") && (
								<FormField
									control={form.control}
									name="databaseName"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Database Name</FormLabel>
											<FormControl>
												<Input placeholder="Database Name" {...field} />
											</FormControl>

											<FormMessage />
										</FormItem>
									)}
								/>
							)}

							{type === "libsql" && (
								<FormField
									control={form.control}
									name="sqldNode"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Sqld Node</FormLabel>
											<Select
												onValueChange={field.onChange}
												defaultValue={field.value || "primary"}
											>
												<SelectTrigger className="w-full">
													<SelectValue placeholder={"primary"} />
												</SelectTrigger>
												<SelectContent>
													<SelectGroup>
														{["primary", "replica"].map((node) => (
															<SelectItem key={node} value={node}>
																{node.charAt(0).toUpperCase() + node.slice(1)}
															</SelectItem>
														))}
													</SelectGroup>
												</SelectContent>
											</Select>
											<FormMessage />
										</FormItem>
									)}
								/>
							)}
							{type === "libsql" && sqldNode === "replica" && (
								<FormField
									control={form.control}
									name="sqldPrimaryUrl"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Sqld Primary URL</FormLabel>
											<FormControl>
												<Input
													placeholder={"https://<host>:<port>"}
													autoComplete="off"
													{...field}
												/>
											</FormControl>

											<FormMessage />
										</FormItem>
									)}
								/>
							)}
							{type === "libsql" && (
								<FormField
									control={form.control}
									name="enableNamespaces"
									render={({ field }) => {
										return (
											<FormItem>
												<FormLabel>Enable Namespaces</FormLabel>
												<FormControl>
													<Select
														onValueChange={(value) =>
															field.onChange(Boolean(value))
														}
														defaultValue={
															field.value ? String(field.value) : "false"
														}
													>
														<SelectTrigger className="w-full">
															<SelectValue placeholder={"false"} />
														</SelectTrigger>
														<SelectContent>
															<SelectGroup>
																{["false", "true"].map((node) => (
																	<SelectItem key={node} value={node}>
																		{node.charAt(0).toUpperCase() +
																			node.slice(1)}
																	</SelectItem>
																))}
															</SelectGroup>
														</SelectContent>
													</Select>
												</FormControl>

												<FormMessage />
											</FormItem>
										);
									}}
								/>
							)}
							{(type === "libsql" ||
								type === "mariadb" ||
								type === "mongo" ||
								type === "mysql" ||
								type === "postgres") && (
								<FormField
									control={form.control}
									name="databaseUser"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Database User</FormLabel>
											<FormControl>
												<Input
													placeholder={`Default ${databasesUserDefaultPlaceholder[type]}`}
													autoComplete="off"
													{...field}
												/>
											</FormControl>

											<FormMessage />
										</FormItem>
									)}
								/>
							)}

							<FormField
								control={form.control}
								name="databasePassword"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Database Password</FormLabel>
										<FormControl>
											<Input
												type="password"
												placeholder="******************"
												autoComplete="one-time-code"
												enablePasswordGenerator={true}
												{...field}
											/>
										</FormControl>

										<FormMessage />
									</FormItem>
								)}
							/>
							{(type === "mariadb" || type === "mysql") && (
								<FormField
									control={form.control}
									name="databaseRootPassword"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Database Root password</FormLabel>
											<FormControl>
												<Input
													type="password"
													placeholder="******************"
													enablePasswordGenerator={true}
													{...field}
												/>
											</FormControl>

											<FormMessage />
										</FormItem>
									)}
								/>
							)}

							<FormField
								control={form.control}
								name="dockerImage"
								defaultValue={form.formState.defaultValues?.dockerImage}
								render={({ field }) => {
									return (
										<FormItem>
											<FormLabel>Docker image</FormLabel>
											<FormControl>
												<Input
													placeholder={`Default ${dockerImageDefaultPlaceholder[type]}`}
													{...field}
												/>
											</FormControl>

											<FormMessage />
										</FormItem>
									);
								}}
							/>

							{type === "mongo" && (
								<FormField
									control={form.control}
									name="replicaSets"
									render={({ field }) => {
										return (
											<FormItem className="flex flex-row items-center justify-between p-3 mt-4 border rounded-lg shadow-xs">
												<div className="space-y-0.5">
													<FormLabel>Use Replica Sets</FormLabel>
												</div>
												<FormControl>
													<Switch
														checked={field.value}
														onCheckedChange={field.onChange}
													/>
												</FormControl>

												<FormMessage />
											</FormItem>
										);
									}}
								/>
							)}
						</div>
					</div>
				</form>

				<FormFooter page={!!onDone} onCancel={onDone}>
					<Button
						isLoading={form.formState.isSubmitting}
						form="hook-form"
						type="submit"
					>
						Create
					</Button>
				</FormFooter>
			</Form>
		</>
	);
	if (onDone)
		return <div className="flex max-w-3xl flex-col gap-6">{body}</div>;

	return (
		<Dialog open={visible} onOpenChange={setVisible}>
			<DialogTrigger className="w-full">
				<DropdownMenuItem
					className="w-full cursor-pointer space-x-3"
					closeOnClick={false}
				>
					<Database className="size-4 text-muted-foreground" />
					<span>Database</span>
				</DropdownMenuItem>
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg md:max-h-[90vh]  sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Databases</DialogTitle>
				</DialogHeader>
				{body}
			</DialogContent>
		</Dialog>
	);
};
