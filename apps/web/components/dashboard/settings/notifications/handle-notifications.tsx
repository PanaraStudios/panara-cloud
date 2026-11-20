"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import {
	Mail,
	PenBoxIcon,
	PlusIcon,
	SendIcon,
	Trash2,
	WebhookIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
	DiscordIcon,
	GotifyIcon,
	LarkIcon,
	MattermostIcon,
	NtfyIcon,
	PushoverIcon,
	ResendIcon,
	SlackIcon,
	TeamsIcon,
	TelegramIcon,
} from "@/components/icons/notification-icons";
import { FormError } from "@/components/settings/form-kit";
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
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";

const notificationBaseSchema = z.object({
	name: z.string().min(1, {
		message: "Name is required",
	}),
	appDeploy: z.boolean().default(false),
	appBuildError: z.boolean().default(false),
	databaseBackup: z.boolean().default(false),
	panelBackup: z.boolean().default(false),
	volumeBackup: z.boolean().default(false),
	panelRestart: z.boolean().default(false),
	dockerCleanup: z.boolean().default(false),
	serverThreshold: z.boolean().default(false),
});

// Saved credentials are never sent back to the browser, so when editing a
// notification without changing its provider the secret fields may stay empty
// to keep the stored values.
const secret = (required: boolean, message: string) =>
	required ? z.string().min(1, { message }) : z.string();

export const buildNotificationSchema = (requireSecrets: boolean) =>
	z.discriminatedUnion("type", [
		z
			.object({
				type: z.literal("slack"),
				webhookUrl: secret(requireSecrets, "Webhook URL is required"),
				channel: z.string(),
			})
			.merge(notificationBaseSchema),
		z
			.object({
				type: z.literal("telegram"),
				botToken: secret(requireSecrets, "Bot Token is required"),
				chatId: z.string().min(1, { message: "Chat ID is required" }),
				messageThreadId: z.string().optional(),
			})
			.merge(notificationBaseSchema),
		z
			.object({
				type: z.literal("discord"),
				webhookUrl: secret(requireSecrets, "Webhook URL is required"),
				decoration: z.boolean().default(true),
			})
			.merge(notificationBaseSchema),
		z
			.object({
				type: z.literal("email"),
				smtpServer: z.string().min(1, { message: "SMTP Server is required" }),
				smtpPort: z.number().min(1, { message: "SMTP Port is required" }),
				username: z.string().min(1, { message: "Username is required" }),
				password: secret(requireSecrets, "Password is required"),
				fromAddress: z.string().min(1, { message: "From Address is required" }),
				toAddresses: z
					.array(
						z.string().trim().min(1, { message: "Email is required" }).email({
							message: "Email is invalid",
						}),
					)
					.min(1, { message: "At least one email is required" }),
			})
			.merge(notificationBaseSchema),
		z
			.object({
				type: z.literal("resend"),
				apiKey: secret(requireSecrets, "API Key is required"),
				fromAddress: z
					.string()
					.trim()
					.min(1, { message: "From Address is required" })
					.email({ message: "Email is invalid" }),
				toAddresses: z
					.array(
						z.string().trim().min(1, { message: "Email is required" }).email({
							message: "Email is invalid",
						}),
					)
					.min(1, { message: "At least one email is required" }),
			})
			.merge(notificationBaseSchema),
		z
			.object({
				type: z.literal("gotify"),
				serverUrl: z.string().min(1, { message: "Server URL is required" }),
				appToken: secret(requireSecrets, "App Token is required"),
				priority: z.number().min(1).max(10).default(5),
				decoration: z.boolean().default(true),
			})
			.merge(notificationBaseSchema),
		z
			.object({
				type: z.literal("ntfy"),
				serverUrl: z.string().min(1, { message: "Server URL is required" }),
				topic: z.string().min(1, { message: "Topic is required" }),
				accessToken: z.string().optional(),
				priority: z.number().min(1).max(5).default(3),
			})
			.merge(notificationBaseSchema),
		z
			.object({
				type: z.literal("mattermost"),
				webhookUrl: secret(requireSecrets, "Webhook URL is required"),
				channel: z.string().optional(),
				username: z.string().optional(),
			})
			.merge(notificationBaseSchema),
		z
			.object({
				type: z.literal("pushover"),
				userKey: secret(requireSecrets, "User Key is required"),
				apiToken: secret(requireSecrets, "API Token is required"),
				priority: z.number().min(-2).max(2).default(0),
				retry: z.number().min(30).nullish(),
				expire: z.number().min(1).max(10800).nullish(),
			})
			.merge(notificationBaseSchema),
		z
			.object({
				type: z.literal("custom"),
				endpoint: z.string().min(1, { message: "Endpoint URL is required" }),
				headers: z
					.array(
						z.object({
							key: z.string(),
							value: z.string(),
						}),
					)
					.optional()
					.default([]),
			})
			.merge(notificationBaseSchema),
		z
			.object({
				type: z.literal("lark"),
				webhookUrl: secret(requireSecrets, "Webhook URL is required"),
			})
			.merge(notificationBaseSchema),
		z
			.object({
				type: z.literal("teams"),
				webhookUrl: secret(requireSecrets, "Webhook URL is required"),
			})
			.merge(notificationBaseSchema),
	]);

export const notificationSchema = buildNotificationSchema(true);

export const notificationsMap = {
	slack: {
		icon: <SlackIcon />,
		label: "Slack",
	},
	telegram: {
		icon: <TelegramIcon />,
		label: "Telegram",
	},
	discord: {
		icon: <DiscordIcon />,
		label: "Discord",
	},
	lark: {
		icon: <LarkIcon className="text-muted-foreground" />,
		label: "Lark",
	},
	teams: {
		icon: <TeamsIcon className="text-muted-foreground" />,
		label: "Microsoft Teams",
	},
	email: {
		icon: <Mail className="text-muted-foreground" />,
		label: "Email",
	},
	resend: {
		icon: <ResendIcon className="text-muted-foreground" />,
		label: "Resend",
	},
	gotify: {
		icon: <GotifyIcon />,
		label: "Gotify",
	},
	ntfy: {
		icon: <NtfyIcon />,
		label: "ntfy",
	},
	mattermost: {
		icon: <MattermostIcon />,
		label: "Mattermost",
	},
	pushover: {
		icon: <PushoverIcon />,
		label: "Pushover",
	},
	custom: {
		icon: <WebhookIcon className="text-muted-foreground" />,
		label: "Custom",
	},
};

export type NotificationSchema = z.infer<typeof notificationSchema>;

interface Props {
	asPage?: boolean;
	notificationId?: string;
}

type NotificationArgs = FunctionArgs<typeof api.platform.notifications.create>;

const filled = (credentials: Record<string, string>) =>
	Object.fromEntries(
		Object.entries(credentials).filter(([, value]) => value.trim() !== ""),
	);

const toPayload = (
	data: NotificationSchema,
): Pick<NotificationArgs, "channel" | "credentials" | "events"> => {
	const events = {
		appDeploy: data.appDeploy,
		appBuildError: data.appBuildError,
		databaseBackup: data.databaseBackup,
		volumeBackup: data.volumeBackup,
		dockerCleanup: data.dockerCleanup,
		serverThreshold: data.serverThreshold,
		panelRestart: data.panelRestart,
		panelBackup: data.panelBackup,
	};
	switch (data.type) {
		case "slack":
			return {
				events,
				channel: { type: "slack", channel: data.channel || undefined },
				credentials: { webhookUrl: data.webhookUrl },
			};
		case "telegram":
			return {
				events,
				channel: {
					type: "telegram",
					chatId: data.chatId,
					messageThreadId: data.messageThreadId || undefined,
				},
				credentials: { botToken: data.botToken },
			};
		case "discord":
			return {
				events,
				channel: { type: "discord", decoration: data.decoration },
				credentials: { webhookUrl: data.webhookUrl },
			};
		case "email":
			return {
				events,
				channel: {
					type: "email",
					smtpServer: data.smtpServer,
					smtpPort: data.smtpPort,
					username: data.username,
					fromAddress: data.fromAddress,
					toAddresses: data.toAddresses,
				},
				credentials: { password: data.password },
			};
		case "resend":
			return {
				events,
				channel: {
					type: "resend",
					fromAddress: data.fromAddress,
					toAddresses: data.toAddresses,
				},
				credentials: { apiKey: data.apiKey },
			};
		case "gotify":
			return {
				events,
				channel: {
					type: "gotify",
					serverUrl: data.serverUrl,
					priority: data.priority,
					decoration: data.decoration,
				},
				credentials: { appToken: data.appToken },
			};
		case "ntfy":
			return {
				events,
				channel: {
					type: "ntfy",
					serverUrl: data.serverUrl,
					topic: data.topic,
					priority: data.priority,
				},
				credentials: { accessToken: data.accessToken ?? "" },
			};
		case "mattermost":
			return {
				events,
				channel: {
					type: "mattermost",
					channel: data.channel || undefined,
					username: data.username || undefined,
				},
				credentials: { webhookUrl: data.webhookUrl },
			};
		case "pushover":
			return {
				events,
				channel: {
					type: "pushover",
					priority: data.priority,
					retry: data.priority === 2 ? (data.retry ?? undefined) : undefined,
					expire: data.priority === 2 ? (data.expire ?? undefined) : undefined,
				},
				credentials: { userKey: data.userKey, apiToken: data.apiToken },
			};
		case "custom": {
			const headers = Object.fromEntries(
				(data.headers ?? [])
					.filter(({ key }) => key.trim())
					.map(({ key, value }) => [key, value]),
			);
			return {
				events,
				channel: { type: "custom", endpoint: data.endpoint },
				credentials: {
					headers:
						Object.keys(headers).length > 0 ? JSON.stringify(headers) : "",
				},
			};
		}
		case "lark":
			return {
				events,
				channel: { type: "lark" },
				credentials: { webhookUrl: data.webhookUrl },
			};
		case "teams":
			return {
				events,
				channel: { type: "teams" },
				credentials: { webhookUrl: data.webhookUrl },
			};
	}
};

const strictResolver = zodResolver(notificationSchema);
const keepSecretsResolver = zodResolver(buildNotificationSchema(false));

export const HandleNotifications = ({ notificationId, asPage }: Props) => {
	const [visible, setVisible] = useState(false);
	const router = useRouter();
	const { active } = useOrganization();

	const notification = useQuery(
		api.platform.notifications.get,
		notificationId
			? { notificationId: notificationId as Id<"notifications"> }
			: "skip",
	);
	const createNotification = useAction(api.platform.notifications.create);
	const updateNotification = useAction(api.platform.notifications.update);
	const testNotification = useAction(api.platform.notifications.test);
	const [isTesting, setIsTesting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const savedType = useRef<string | undefined>(undefined);
	savedType.current = notification?.channel.type;
	const resolver: typeof strictResolver = (values, context, options) =>
		(values.type === savedType.current ? keepSecretsResolver : strictResolver)(
			values,
			context,
			options,
		);

	const form = useForm({
		defaultValues: {
			type: "slack",
			webhookUrl: "",
			channel: "",
			name: "",
		},
		resolver,
	});
	const type = form.watch("type");
	const keepsSecrets = !!notification && notification.channel.type === type;

	const { fields, append, remove } = useFieldArray({
		control: form.control,
		name: "toAddresses" as never,
	});

	const {
		fields: headerFields,
		append: appendHeader,
		remove: removeHeader,
	} = useFieldArray({
		control: form.control,
		name: "headers" as never,
	});

	useEffect(() => {
		if ((type === "email" || type === "resend") && fields.length === 0) {
			append("");
		}
	}, [type, append, fields.length]);

	useEffect(() => {
		if (notification) {
			const base = {
				appBuildError: notification.events.appBuildError,
				appDeploy: notification.events.appDeploy,
				panelRestart: notification.events.panelRestart,
				databaseBackup: notification.events.databaseBackup,
				panelBackup: notification.events.panelBackup,
				volumeBackup: notification.events.volumeBackup,
				dockerCleanup: notification.events.dockerCleanup,
				serverThreshold: notification.events.serverThreshold,
				name: notification.name,
			};
			const channel = notification.channel;
			if (channel.type === "slack") {
				form.reset({
					...base,
					type: channel.type,
					webhookUrl: "",
					channel: channel.channel || "",
				});
			} else if (channel.type === "telegram") {
				form.reset({
					...base,
					type: channel.type,
					botToken: "",
					messageThreadId: channel.messageThreadId || "",
					chatId: channel.chatId,
				});
			} else if (channel.type === "discord") {
				form.reset({
					...base,
					type: channel.type,
					webhookUrl: "",
					decoration: channel.decoration,
				});
			} else if (channel.type === "email") {
				form.reset({
					...base,
					type: channel.type,
					smtpServer: channel.smtpServer,
					smtpPort: channel.smtpPort,
					username: channel.username,
					password: "",
					toAddresses: channel.toAddresses,
					fromAddress: channel.fromAddress,
				});
			} else if (channel.type === "resend") {
				form.reset({
					...base,
					type: channel.type,
					apiKey: "",
					toAddresses: channel.toAddresses,
					fromAddress: channel.fromAddress,
				});
			} else if (channel.type === "gotify") {
				form.reset({
					...base,
					type: channel.type,
					appToken: "",
					decoration: channel.decoration,
					priority: channel.priority,
					serverUrl: channel.serverUrl,
				});
			} else if (channel.type === "ntfy") {
				form.reset({
					...base,
					type: channel.type,
					accessToken: "",
					topic: channel.topic,
					priority: channel.priority,
					serverUrl: channel.serverUrl,
				});
			} else if (channel.type === "mattermost") {
				form.reset({
					...base,
					type: channel.type,
					webhookUrl: "",
					channel: channel.channel || "",
					username: channel.username || "",
				});
			} else if (channel.type === "lark" || channel.type === "teams") {
				form.reset({
					...base,
					type: channel.type,
					webhookUrl: "",
				});
			} else if (channel.type === "custom") {
				form.reset({
					...base,
					type: channel.type,
					endpoint: channel.endpoint,
					headers: [],
				});
			} else if (channel.type === "pushover") {
				form.reset({
					...base,
					type: channel.type,
					userKey: "",
					apiToken: "",
					priority: channel.priority,
					retry: channel.retry ?? undefined,
					expire: channel.expire ?? undefined,
				});
			}
		} else {
			form.reset();
		}
	}, [form, form.reset, form.formState.isSubmitSuccessful, notification]);

	const onSubmit = async (data: NotificationSchema) => {
		if (
			data.type === "pushover" &&
			data.priority === 2 &&
			(data.retry == null || data.expire == null)
		) {
			toast.error("Retry and expire are required for emergency priority (2)");
			return;
		}
		const { channel, credentials, events } = toPayload(data);
		setError(null);
		try {
			if (notificationId) {
				await updateNotification({
					notificationId: notificationId as Id<"notifications">,
					name: data.name,
					channel,
					events,
					credentials: filled(credentials),
				});
			} else {
				await createNotification({
					organizationId: active.id,
					name: data.name,
					channel,
					events,
					credentials,
				});
			}
			toast.success(
				notificationId ? "Notification Updated" : "Notification Created",
			);
			form.reset({
				type: "slack",
				webhookUrl: "",
			});
			setVisible(false);
			if (asPage) router.push("/settings/notifications");
		} catch (error) {
			setError(errorMessage(error));
			toast.error(
				notificationId
					? "Error updating a notification"
					: "Error creating a notification",
			);
		}
	};
	const footer = asPage ? (
		<div className="flex flex-row items-center gap-2 border-border border-t pt-4">
			<Button
				isLoading={isTesting}
				variant="outline"
				type="button"
				onClick={async () => {
					const isValid = await form.trigger();
					if (!isValid) return;

					const data = form.getValues() as NotificationSchema;
					setIsTesting(true);
					try {
						if (
							data.type === "pushover" &&
							data.priority === 2 &&
							(data.retry == null || data.expire == null)
						) {
							throw new Error(
								"Retry and expire are required for emergency priority (2)",
							);
						}
						const { channel, credentials } = toPayload(data);
						await testNotification(
							notificationId
								? {
										notificationId: notificationId as Id<"notifications">,
										channel,
										credentials: filled(credentials),
									}
								: {
										organizationId: active.id,
										channel,
										credentials: filled(credentials),
									},
						);
						toast.success("Connection works");
					} catch (error) {
						toast.error(`Error testing the provider: ${errorMessage(error)}`);
					} finally {
						setIsTesting(false);
					}
				}}
			>
				<SendIcon data-icon="inline-start" />
				Send test
			</Button>
			<span className="flex-1" />
			<Button
				type="button"
				variant="ghost"
				onClick={() => router.push("/settings/notifications")}
			>
				Cancel
			</Button>
			<Button
				isLoading={form.formState.isSubmitting}
				form="hook-form"
				type="submit"
			>
				{notificationId ? "Save channel" : "Create channel"}
			</Button>
		</div>
	) : (
		<DialogFooter className="flex w-full flex-row justify-between! gap-2">
			<Button
				isLoading={isTesting}
				variant="outline"
				type="button"
				onClick={async () => {
					const isValid = await form.trigger();
					if (!isValid) return;

					const data = form.getValues() as NotificationSchema;
					setIsTesting(true);
					try {
						if (
							data.type === "pushover" &&
							data.priority === 2 &&
							(data.retry == null || data.expire == null)
						) {
							throw new Error(
								"Retry and expire are required for emergency priority (2)",
							);
						}
						const { channel, credentials } = toPayload(data);
						await testNotification(
							notificationId
								? {
										notificationId: notificationId as Id<"notifications">,
										channel,
										credentials: filled(credentials),
									}
								: {
										organizationId: active.id,
										channel,
										credentials: filled(credentials),
									},
						);
						toast.success("Connection works");
					} catch (error) {
						toast.error(`Error testing the provider: ${errorMessage(error)}`);
					} finally {
						setIsTesting(false);
					}
				}}
			>
				Test Notification
			</Button>
			<Button
				isLoading={form.formState.isSubmitting}
				form="hook-form"
				type="submit"
			>
				{notificationId ? "Update" : "Create"}
			</Button>
		</DialogFooter>
	);
	const formBody = (
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
							<FormLabel>Type</FormLabel>
							<FormControl>
								<RadioGroup
									onValueChange={field.onChange}
									defaultValue={field.value}
									className="flex flex-wrap gap-2"
								>
									{Object.entries(notificationsMap).map(([key, value]) => (
										<FormItem key={key} className="flex items-center space-y-0">
											<FormControl>
												<div>
													<RadioGroupItem
														value={key}
														id={key}
														className="peer sr-only absolute!"
													/>
													<Label
														htmlFor={key}
														className="flex h-8 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 font-normal text-sm hover:bg-muted peer-data-checked:border-foreground peer-data-checked:bg-muted [&_img]:size-4 [&_svg]:size-4"
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
							{error && (
								<FormError title="Couldn't save the channel." message={error} />
							)}
						</FormItem>
					)}
				/>

				<div className="flex flex-col gap-4">
					{keepsSecrets && (
						<FormDescription>
							Saved tokens, passwords and webhook URLs are stored encrypted and
							not shown. Leave them empty to keep the current values.
						</FormDescription>
					)}
					<div className="flex flex-col gap-4">
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input placeholder="Deploys to #ops" {...field} />
									</FormControl>

									<FormMessage />
								</FormItem>
							)}
						/>

						{type === "slack" && (
							<>
								<FormField
									control={form.control}
									name="webhookUrl"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Webhook URL</FormLabel>
											<FormControl>
												<Input
													placeholder="https://hooks.slack.com/services/…"
													{...field}
												/>
											</FormControl>

											<FormMessage />
										</FormItem>
									)}
								/>

								<FormField
									control={form.control}
									name="channel"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Channel</FormLabel>
											<FormControl>
												<Input placeholder="Channel" {...field} />
											</FormControl>

											<FormMessage />
										</FormItem>
									)}
								/>
							</>
						)}

						{type === "telegram" && (
							<>
								<FormField
									control={form.control}
									name="botToken"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Bot token</FormLabel>
											<FormControl>
												<Input
													placeholder="6660491268:AAFMGmajZOVewpMNZCgJr5H7cpXpoZPgvXw"
													{...field}
												/>
											</FormControl>

											<FormMessage />
										</FormItem>
									)}
								/>

								<FormField
									control={form.control}
									name="chatId"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Chat ID</FormLabel>
											<FormControl>
												<Input placeholder="431231869" {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>

								<FormField
									control={form.control}
									name="messageThreadId"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Message thread ID</FormLabel>
											<FormControl>
												<Input placeholder="11" {...field} />
											</FormControl>

											<FormMessage />
											<FormDescription>
												Optional. Use it when you want to send notifications to
												a specific topic in a group.
											</FormDescription>
										</FormItem>
									)}
								/>
							</>
						)}

						{type === "discord" && (
							<>
								<FormField
									control={form.control}
									name="webhookUrl"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Webhook URL</FormLabel>
											<FormControl>
												<Input
													placeholder="https://discord.com/api/webhooks/…"
													{...field}
												/>
											</FormControl>

											<FormMessage />
										</FormItem>
									)}
								/>

								<FormField
									control={form.control}
									name="decoration"
									defaultValue={true}
									render={({ field }) => (
										<FormItem className="flex min-h-14 items-center justify-between gap-4 space-y-0 border-border border-t py-2.5">
											<div className="space-y-0.5">
												<FormLabel>Decoration</FormLabel>
												<FormDescription>
													Add emojis to the message.
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
							</>
						)}

						{type === "email" && (
							<>
								<div className="grid w-full gap-4 sm:grid-cols-2">
									<FormField
										control={form.control}
										name="smtpServer"
										render={({ field }) => (
											<FormItem className="w-full">
												<FormLabel>SMTP server</FormLabel>
												<FormControl>
													<Input placeholder="smtp.gmail.com" {...field} />
												</FormControl>

												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="smtpPort"
										render={({ field }) => (
											<FormItem className="w-full">
												<FormLabel>SMTP port</FormLabel>
												<FormControl>
													<Input
														placeholder="587"
														{...field}
														onChange={(e) => {
															const value = e.target.value;
															if (value === "") {
																field.onChange(undefined);
															} else {
																const port = Number.parseInt(value, 10);
																if (port > 0 && port < 65536) {
																	field.onChange(port);
																}
															}
														}}
														value={field.value || ""}
														type="number"
													/>
												</FormControl>

												<FormMessage />
											</FormItem>
										)}
									/>
								</div>

								<div className="grid w-full gap-4 sm:grid-cols-2">
									<FormField
										control={form.control}
										name="username"
										render={({ field }) => (
											<FormItem className="w-full">
												<FormLabel>Username</FormLabel>
												<FormControl>
													<Input placeholder="username" {...field} />
												</FormControl>

												<FormMessage />
											</FormItem>
										)}
									/>

									<FormField
										control={form.control}
										name="password"
										render={({ field }) => (
											<FormItem className="w-full">
												<FormLabel>Password</FormLabel>
												<FormControl>
													<Input
														type="password"
														placeholder="******************"
														{...field}
													/>
												</FormControl>

												<FormMessage />
											</FormItem>
										)}
									/>
								</div>

								<FormField
									control={form.control}
									name="fromAddress"
									render={({ field }) => (
										<FormItem>
											<FormLabel>From address</FormLabel>
											<FormControl>
												<Input placeholder="from@example.com" {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<div className="flex flex-col gap-2 pt-2">
									<FormLabel>To addresses</FormLabel>

									{fields.map((field, index) => (
										<div key={field.id} className="flex flex-row gap-2 w-full">
											<FormField
												control={form.control}
												name={`toAddresses.${index}`}
												render={({ field }) => (
													<FormItem className="w-full">
														<FormControl>
															<Input
																placeholder="email@example.com"
																className="w-full"
																{...field}
															/>
														</FormControl>

														<FormMessage />
													</FormItem>
												)}
											/>
											<Button
												variant="ghost"
												size="icon"
												type="button"
												aria-label="Remove address"
												onClick={() => {
													remove(index);
												}}
											>
												<Trash2 />
											</Button>
										</div>
									))}
									{type === "email" &&
										"toAddresses" in form.formState.errors && (
											<div className="text-destructive text-sm">
												{form.formState?.errors?.toAddresses?.root?.message}
											</div>
										)}
								</div>

								<Button
									variant="outline"
									size="sm"
									type="button"
									className="w-fit"
									onClick={() => {
										append("");
									}}
								>
									<PlusIcon data-icon="inline-start" />
									Add address
								</Button>
							</>
						)}

						{type === "resend" && (
							<>
								<FormField
									control={form.control}
									name="apiKey"
									render={({ field }) => (
										<FormItem>
											<FormLabel>API key</FormLabel>
											<FormControl>
												<Input
													type="password"
													placeholder="re_********"
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>

								<FormField
									control={form.control}
									name="fromAddress"
									render={({ field }) => (
										<FormItem>
											<FormLabel>From address</FormLabel>
											<FormControl>
												<Input placeholder="from@example.com" {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>

								<div className="flex flex-col gap-2 pt-2">
									<FormLabel>To addresses</FormLabel>

									{fields.map((field, index) => (
										<div key={field.id} className="flex flex-row gap-2 w-full">
											<FormField
												control={form.control}
												name={`toAddresses.${index}`}
												render={({ field }) => (
													<FormItem className="w-full">
														<FormControl>
															<Input
																placeholder="email@example.com"
																className="w-full"
																{...field}
															/>
														</FormControl>

														<FormMessage />
													</FormItem>
												)}
											/>
											<Button
												variant="ghost"
												size="icon"
												type="button"
												aria-label="Remove address"
												onClick={() => {
													remove(index);
												}}
											>
												<Trash2 />
											</Button>
										</div>
									))}
									{type === "resend" &&
										"toAddresses" in form.formState.errors && (
											<div className="text-destructive text-sm">
												{form.formState?.errors?.toAddresses?.root?.message}
											</div>
										)}
								</div>

								<Button
									variant="outline"
									size="sm"
									type="button"
									className="w-fit"
									onClick={() => {
										append("");
									}}
								>
									<PlusIcon data-icon="inline-start" />
									Add address
								</Button>
							</>
						)}

						{type === "gotify" && (
							<>
								<FormField
									control={form.control}
									name="serverUrl"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Server URL</FormLabel>
											<FormControl>
												<Input
													placeholder="https://gotify.example.com"
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="appToken"
									render={({ field }) => (
										<FormItem>
											<FormLabel>App token</FormLabel>
											<FormControl>
												<Input placeholder="AzxcvbnmKjhgfdsa..." {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="priority"
									defaultValue={5}
									render={({ field }) => (
										<FormItem className="w-full">
											<FormLabel>Priority</FormLabel>
											<FormControl>
												<Input
													placeholder="5"
													{...field}
													onChange={(e) => {
														const value = e.target.value;
														if (value) {
															const port = Number.parseInt(value, 10);
															if (port > 0 && port < 10) {
																field.onChange(port);
															}
														}
													}}
													type="number"
												/>
											</FormControl>
											<FormDescription>
												Message priority (1-10, default: 5)
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="decoration"
									defaultValue={true}
									render={({ field }) => (
										<FormItem className="flex min-h-14 items-center justify-between gap-4 space-y-0 border-border border-t py-2.5">
											<div className="space-y-0.5">
												<FormLabel>Decoration</FormLabel>
												<FormDescription>
													Add emojis to the message.
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
							</>
						)}

						{type === "ntfy" && (
							<>
								<FormField
									control={form.control}
									name="serverUrl"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Server URL</FormLabel>
											<FormControl>
												<Input placeholder="https://ntfy.sh" {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="topic"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Topic</FormLabel>
											<FormControl>
												<Input placeholder="deployments" {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="accessToken"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Access token</FormLabel>
											<FormControl>
												<Input
													placeholder="AzxcvbnmKjhgfdsa..."
													{...field}
													value={field.value ?? ""}
												/>
											</FormControl>
											<FormDescription>
												Optional. Leave blank for public topics.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="priority"
									defaultValue={3}
									render={({ field }) => (
										<FormItem className="w-full">
											<FormLabel>Priority</FormLabel>
											<FormControl>
												<Input
													placeholder="3"
													{...field}
													onChange={(e) => {
														const value = e.target.value;
														if (value) {
															const port = Number.parseInt(value, 10);
															if (port > 0 && port <= 5) {
																field.onChange(port);
															}
														}
													}}
													type="number"
												/>
											</FormControl>
											<FormDescription>
												Message priority (1-5, default: 3)
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
							</>
						)}

						{type === "mattermost" && (
							<>
								<FormField
									control={form.control}
									name="webhookUrl"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Webhook URL</FormLabel>
											<FormControl>
												<Input
													placeholder="https://your-mattermost.com/hooks/xxx-generatedkey-xxx"
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>

								<FormField
									control={form.control}
									name="channel"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Channel</FormLabel>
											<FormControl>
												<Input placeholder="deployments" {...field} />
											</FormControl>
											<FormDescription>
												Optional. Channel to post to (without #).
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>

								<FormField
									control={form.control}
									name="username"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Username</FormLabel>
											<FormControl>
												<Input placeholder="Panara Cloud" {...field} />
											</FormControl>
											<FormDescription>
												Optional. Display name for the webhook.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
							</>
						)}

						{type === "custom" && (
							<div className="space-y-4">
								<FormField
									control={form.control}
									name="endpoint"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Webhook URL</FormLabel>
											<FormControl>
												<Input
													placeholder="https://api.example.com/webhook"
													{...field}
												/>
											</FormControl>
											<FormDescription>
												The URL where POST requests will be sent with
												notification data.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>

								<div className="space-y-3">
									<div>
										<FormLabel>Headers</FormLabel>
										<FormDescription>
											Optional. Custom headers for your POST request (e.g.,
											Authorization, Content-Type).
										</FormDescription>
									</div>

									<div className="space-y-2">
										{headerFields.map((field, index) => (
											<div key={field.id} className="flex items-center gap-2">
												<FormField
													control={form.control}
													name={`headers.${index}.key` as never}
													render={({ field }) => (
														<FormItem className="flex-1">
															<FormControl>
																<Input placeholder="Key" {...field} />
															</FormControl>
														</FormItem>
													)}
												/>
												<FormField
													control={form.control}
													name={`headers.${index}.value` as never}
													render={({ field }) => (
														<FormItem className="flex-2">
															<FormControl>
																<Input placeholder="Value" {...field} />
															</FormControl>
														</FormItem>
													)}
												/>
												<Button
													type="button"
													variant="ghost"
													size="icon"
													aria-label="Remove header"
													onClick={() => removeHeader(index)}
												>
													<Trash2 />
												</Button>
											</div>
										))}
									</div>

									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => appendHeader({ key: "", value: "" })}
										className="w-fit"
									>
										<PlusIcon data-icon="inline-start" />
										Add header
									</Button>
								</div>
							</div>
						)}

						{type === "lark" && (
							<>
								<FormField
									control={form.control}
									name="webhookUrl"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Webhook URL</FormLabel>
											<FormControl>
												<Input
													placeholder="https://open.larksuite.com/open-apis/bot/v2/hook/xxxxxxxxxxxxxxxxxxxxxxxx"
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
							</>
						)}

						{type === "teams" && (
							<>
								<FormField
									control={form.control}
									name="webhookUrl"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Webhook URL</FormLabel>
											<FormControl>
												<Input
													placeholder="https://xxx.webhook.office.com/webhookb2/..."
													{...field}
												/>
											</FormControl>
											<FormDescription>
												Incoming Webhook URL from a Teams channel. Add an
												Incoming Webhook in your channel settings to get the
												URL.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
							</>
						)}
						{type === "pushover" && (
							<>
								<FormField
									control={form.control}
									name="userKey"
									render={({ field }) => (
										<FormItem>
											<FormLabel>User key</FormLabel>
											<FormControl>
												<Input placeholder="ub3de9kl2q..." {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="apiToken"
									render={({ field }) => (
										<FormItem>
											<FormLabel>API token</FormLabel>
											<FormControl>
												<Input placeholder="a3d9k2q7m4..." {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="priority"
									defaultValue={0}
									render={({ field }) => (
										<FormItem className="w-full">
											<FormLabel>Priority</FormLabel>
											<FormControl>
												<Input
													placeholder="0"
													value={field.value ?? 0}
													onChange={(e) => {
														const value = e.target.value;
														if (value === "" || value === "-") {
															field.onChange(0);
														} else {
															const priority = Number.parseInt(value, 10);
															if (
																!Number.isNaN(priority) &&
																priority >= -2 &&
																priority <= 2
															) {
																field.onChange(priority);
															}
														}
													}}
													type="number"
													min={-2}
													max={2}
												/>
											</FormControl>
											<FormDescription>
												Message priority (-2 to 2, default: 0, emergency: 2)
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
								{form.watch("priority") === 2 && (
									<>
										<FormField
											control={form.control}
											name="retry"
											render={({ field }) => (
												<FormItem className="w-full">
													<FormLabel>Retry (seconds)</FormLabel>
													<FormControl>
														<Input
															placeholder="30"
															{...field}
															value={field.value ?? ""}
															onChange={(e) => {
																const value = e.target.value;
																if (value === "") {
																	field.onChange(undefined);
																} else {
																	const retry = Number.parseInt(value, 10);
																	if (!Number.isNaN(retry)) {
																		field.onChange(retry);
																	}
																}
															}}
															type="number"
															min={30}
														/>
													</FormControl>
													<FormDescription>
														How often (in seconds) to retry. Minimum 30 seconds.
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="expire"
											render={({ field }) => (
												<FormItem className="w-full">
													<FormLabel>Expire (seconds)</FormLabel>
													<FormControl>
														<Input
															placeholder="3600"
															{...field}
															value={field.value ?? ""}
															onChange={(e) => {
																const value = e.target.value;
																if (value === "") {
																	field.onChange(undefined);
																} else {
																	const expire = Number.parseInt(value, 10);
																	if (!Number.isNaN(expire)) {
																		field.onChange(expire);
																	}
																}
															}}
															type="number"
															min={1}
															max={10800}
														/>
													</FormControl>
													<FormDescription>
														How long to keep retrying (max 10800 seconds / 3
														hours).
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>
									</>
								)}
							</>
						)}
					</div>
				</div>
				<div className="flex flex-col gap-4 border-border border-t pt-8">
					<div className="space-y-1">
						<h2 className="font-semibold text-[15px]">Events</h2>
						<p className="text-muted-foreground text-sm">
							What gets sent to this channel.
						</p>
					</div>

					<div className="flex flex-col divide-y divide-border border-border border-t">
						<FormField
							control={form.control}
							name="appDeploy"
							render={({ field }) => (
								<FormItem className="flex min-h-14 flex-row items-center justify-between gap-4 space-y-0 py-2.5">
									<div className="">
										<FormLabel>App deployed</FormLabel>
										<FormDescription>When an app is deployed.</FormDescription>
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
							name="appBuildError"
							render={({ field }) => (
								<FormItem className="flex min-h-14 flex-row items-center justify-between gap-4 space-y-0 py-2.5">
									<div className="space-y-0.5">
										<FormLabel>Build failed</FormLabel>
										<FormDescription>When the build fails.</FormDescription>
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
							name="databaseBackup"
							render={({ field }) => (
								<FormItem className="flex min-h-14 flex-row items-center justify-between gap-4 space-y-0 py-2.5">
									<div className="space-y-0.5">
										<FormLabel>Database backup</FormLabel>
										<FormDescription>
											When a database backup is created.
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
							name="panelBackup"
							render={({ field }) => (
								<FormItem className="flex min-h-14 flex-row items-center justify-between gap-4 space-y-0 py-2.5">
									<div className="space-y-0.5">
										<FormLabel>Panel backup</FormLabel>
										<FormDescription>
											When a Panara Cloud backup is created.
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
							name="volumeBackup"
							render={({ field }) => (
								<FormItem className="flex min-h-14 flex-row items-center justify-between gap-4 space-y-0 py-2.5">
									<div className="space-y-0.5">
										<FormLabel>Volume backup</FormLabel>
										<FormDescription>
											When a volume backup is created.
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
							name="dockerCleanup"
							render={({ field }) => (
								<FormItem className="flex min-h-14 flex-row items-center justify-between gap-4 space-y-0 py-2.5">
									<div className="space-y-0.5">
										<FormLabel>Docker cleanup</FormLabel>
										<FormDescription>
											When Docker cleanup is performed.
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
							name="panelRestart"
							render={({ field }) => (
								<FormItem className="flex min-h-14 flex-row items-center justify-between gap-4 space-y-0 py-2.5">
									<div className="space-y-0.5">
										<FormLabel>Panara Cloud restarted</FormLabel>
										<FormDescription>
											When Panara Cloud is restarted.
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
					</div>
				</div>
			</form>

			{footer}
		</Form>
	);
	if (asPage) {
		return (
			<div className="flex w-full max-w-3xl flex-col gap-6 pb-10">
				<div className="space-y-1">
					<p className="text-muted-foreground text-sm">
						<Link
							href="/settings/notifications"
							className="hover:text-foreground"
						>
							Notifications
						</Link>{" "}
						/
					</p>
					<h1 className="text-h3">
						{notificationId ? (notification?.name ?? "Channel") : "Add channel"}
					</h1>
				</div>
				{formBody}
			</div>
		);
	}
	return (
		<Dialog open={visible} onOpenChange={setVisible}>
			<DialogTrigger
				className=""
				render={
					(notificationId ? (
						<Button variant="ghost" size="icon-sm" aria-label="Edit channel">
							<PenBoxIcon />
						</Button>
					) : (
						<Button>
							<PlusIcon data-icon="inline-start" />
							Add Notification
						</Button>
					)) as React.ReactElement
				}
			/>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>
						{notificationId ? "Update" : "Add"} Notification
					</DialogTitle>
					<DialogDescription>
						{notificationId
							? "Update your notification providers for multiple channels."
							: "Create new notification providers for multiple channels."}
					</DialogDescription>
				</DialogHeader>
				{formBody}
			</DialogContent>
		</Dialog>
	);
};
