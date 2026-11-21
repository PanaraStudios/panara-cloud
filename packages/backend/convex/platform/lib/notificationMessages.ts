import { type Infer, v } from "convex/values";
import {
	type EmailStatus,
	escapeHtml,
	renderEmail,
} from "../../lib/emailLayout";
import type {
	notificationChannel,
	notificationEventKey,
} from "../../tables/platform";

const backupStatus = v.union(v.literal("success"), v.literal("error"));

export const notificationEvent = v.union(
	v.object({
		type: v.literal("appDeploy"),
		projectName: v.string(),
		applicationName: v.string(),
		applicationType: v.string(),
		environmentName: v.string(),
		buildLink: v.string(),
		domains: v.array(v.string()),
	}),
	v.object({
		type: v.literal("appBuildError"),
		projectName: v.string(),
		applicationName: v.string(),
		applicationType: v.string(),
		errorMessage: v.string(),
		buildLink: v.string(),
	}),
	v.object({
		type: v.literal("databaseBackup"),
		projectName: v.string(),
		applicationName: v.string(),
		databaseType: v.string(),
		databaseName: v.string(),
		status: backupStatus,
		errorMessage: v.optional(v.string()),
	}),
	v.object({
		type: v.literal("volumeBackup"),
		projectName: v.string(),
		applicationName: v.string(),
		volumeName: v.string(),
		serviceType: v.string(),
		status: backupStatus,
		errorMessage: v.optional(v.string()),
		backupSize: v.optional(v.string()),
	}),
	v.object({ type: v.literal("dockerCleanup"), message: v.string() }),
	v.object({
		type: v.literal("serverThreshold"),
		serverName: v.string(),
		metric: v.union(v.literal("CPU"), v.literal("Memory")),
		value: v.number(),
		threshold: v.number(),
		message: v.string(),
		timestamp: v.number(),
	}),
	v.object({ type: v.literal("panelRestart") }),
	v.object({
		type: v.literal("panelBackup"),
		status: backupStatus,
		errorMessage: v.optional(v.string()),
		backupSize: v.optional(v.string()),
	}),
);

export type NotificationEvent = Infer<typeof notificationEvent>;
export type NotificationEventKey = Infer<typeof notificationEventKey>;
export type NotificationChannel = Infer<typeof notificationChannel>;
export type ChannelType = NotificationChannel["type"];
export type Credentials = Record<string, string>;

export const INSTANCE_EVENTS: ReadonlySet<NotificationEventKey> = new Set([
	"panelRestart",
	"panelBackup",
]);

export const CREDENTIAL_FIELDS: Record<
	ChannelType,
	{ key: string; required: boolean }[]
> = {
	slack: [{ key: "webhookUrl", required: true }],
	telegram: [{ key: "botToken", required: true }],
	discord: [{ key: "webhookUrl", required: true }],
	email: [{ key: "password", required: true }],
	resend: [{ key: "apiKey", required: true }],
	gotify: [{ key: "appToken", required: true }],
	ntfy: [{ key: "accessToken", required: false }],
	mattermost: [{ key: "webhookUrl", required: true }],
	pushover: [
		{ key: "userKey", required: true },
		{ key: "apiToken", required: true },
	],
	custom: [{ key: "headers", required: false }],
	lark: [{ key: "webhookUrl", required: true }],
	teams: [{ key: "webhookUrl", required: true }],
};

const isHttpUrl = (value: string) => {
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:";
	} catch {
		return false;
	}
};

export const parseCustomHeaders = (raw: string | undefined) => {
	if (!raw?.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Custom headers must be a JSON object");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Custom headers must be a JSON object");
	}
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value !== "string") {
			throw new Error(`Custom header "${key}" must be a string`);
		}
		headers[key] = value;
	}
	return headers;
};

// Keeps only the credential keys this channel uses and checks required ones.
export const normalizeCredentials = (
	type: ChannelType,
	credentials: Credentials,
): Credentials => {
	const result: Credentials = {};
	for (const { key, required } of CREDENTIAL_FIELDS[type]) {
		const value = credentials[key]?.trim();
		if (value) {
			result[key] = value;
		} else if (required) {
			throw new Error(`Missing credential "${key}" for ${type}`);
		}
	}
	if (result.webhookUrl && !isHttpUrl(result.webhookUrl)) {
		throw new Error("Webhook URL must be an http(s) URL");
	}
	if (type === "custom") parseCustomHeaders(result.headers);
	return result;
};

export const validateChannel = (channel: NotificationChannel) => {
	switch (channel.type) {
		case "email":
			if (!channel.smtpServer.trim())
				throw new Error("SMTP server is required");
			if (
				!Number.isInteger(channel.smtpPort) ||
				channel.smtpPort < 1 ||
				channel.smtpPort > 65535
			) {
				throw new Error("SMTP port must be between 1 and 65535");
			}
			if (!channel.fromAddress.trim()) {
				throw new Error("From address is required");
			}
			if (channel.toAddresses.length === 0) {
				throw new Error("At least one recipient is required");
			}
			break;
		case "resend":
			if (!channel.fromAddress.trim()) {
				throw new Error("From address is required");
			}
			if (channel.toAddresses.length === 0) {
				throw new Error("At least one recipient is required");
			}
			break;
		case "telegram":
			if (!channel.chatId.trim()) throw new Error("Chat ID is required");
			break;
		case "gotify":
		case "ntfy":
			if (!isHttpUrl(channel.serverUrl)) {
				throw new Error("Server URL must be an http(s) URL");
			}
			if (channel.type === "ntfy" && !channel.topic.trim()) {
				throw new Error("Topic is required");
			}
			break;
		case "custom":
			if (!isHttpUrl(channel.endpoint)) {
				throw new Error("Endpoint must be an http(s) URL");
			}
			break;
		case "pushover":
			if (channel.priority === 2 && (!channel.retry || !channel.expire)) {
				throw new Error("Emergency priority requires retry and expire");
			}
			break;
	}
};

type Status = "success" | "error" | "warning";

export type Fact = { label: string; value: string; emoji: string };

export type NotificationMessage = {
	title: string;
	emoji: string;
	status: Status;
	// Shortcode (without colons) used by Slack, Mattermost and ntfy tags.
	shortcode: string;
	facts: Fact[];
	errorText?: string;
	link?: { url: string; label: string };
	custom: Record<string, unknown>;
	email: { subject: string; html: string };
	date: string;
	timestamp: string;
};

export const formatDate = (ms: number) =>
	`${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

export const formatTelegramErrorMessage = (errorMessage: string) => {
	const escaped = escapeHtml(errorMessage);
	const limit = 3000;
	if (escaped.length <= limit) return escaped;
	let end = limit;
	const ampIdx = escaped.lastIndexOf("&", end);
	if (ampIdx !== -1 && escaped.indexOf(";", ampIdx) >= end) end = ampIdx;
	if (end > 0 && isHighSurrogate(escaped.charCodeAt(end - 1))) end--;
	return `${escaped.substring(0, end)}…`;
};

export type EmailContent = {
	preview: string;
	heading: string;
	intro: string;
	details: { label: string; value: string }[];
	reason?: { label: string; text: string };
	button?: { url: string; label: string };
	/** Defaults to failed when the email carries an error. */
	status?: EmailStatus;
};

const NOTIFICATION_FOOTER =
	"You received this email because this address is on a notification channel in Panara Cloud.";

export const renderEmailHtml = (content: EmailContent): string =>
	renderEmail({
		preview: content.preview,
		title: content.heading,
		intro: content.intro,
		status: content.status ?? (content.reason ? "error" : undefined),
		details: content.details,
		reason: content.reason,
		button: content.button,
		footer: NOTIFICATION_FOOTER,
	});

export const invitationEmail = ({
	email,
	inviteLink,
	organizationName,
	inviterName,
}: {
	email: string;
	inviteLink: string;
	organizationName: string;
	inviterName?: string;
}) => {
	const organization = organizationName || "an organization";
	const subject = `You've been invited to join ${organization} on Panara Cloud`;
	const html = renderEmail({
		preview: subject,
		title: `Join ${organization}`,
		intro: `${inviterName || "A teammate"} invited you to ${organization} on Panara Cloud, where the team deploys and runs its apps.`,
		button: { url: inviteLink, label: "Accept invitation" },
		footer: `This invitation was sent to ${email}. If you weren't expecting it, you can ignore this email.`,
	});
	const text = `You have been invited to join ${organizationName} on Panara Cloud.\n\nAccept the invitation: ${inviteLink}\n\nThis invitation was intended for ${email}. If you were not expecting it, you can ignore this email.`;
	return { subject, html, text };
};

const statusWord = (status: "success" | "error") =>
	status === "success" ? "Successful" : "Failed";

export const buildMessage = (
	event: NotificationEvent,
	sentAt: number,
): NotificationMessage => {
	const date = formatDate(sentAt);
	const timestamp = new Date(sentAt).toISOString();
	const base = { date, timestamp };
	switch (event.type) {
		case "appDeploy": {
			const facts: Fact[] = [
				{ label: "Project", value: event.projectName, emoji: "🛠️" },
				{ label: "Application", value: event.applicationName, emoji: "⚙️" },
				{ label: "Environment", value: event.environmentName, emoji: "🌍" },
				{ label: "Type", value: event.applicationType, emoji: "❔" },
				{ label: "Date", value: date, emoji: "📅" },
			];
			if (event.domains.length > 0) {
				facts.push({
					label: "Domains",
					value: event.domains.join(", "),
					emoji: "🌐",
				});
			}
			return {
				...base,
				title: "Build Success",
				emoji: "✅",
				status: "success",
				shortcode: "white_check_mark",
				facts,
				link: { url: event.buildLink, label: "View Build Details" },
				custom: {
					title: "Build Success",
					message: "Build completed successfully",
					projectName: event.projectName,
					applicationName: event.applicationName,
					applicationType: event.applicationType,
					environmentName: event.environmentName,
					buildLink: event.buildLink,
					timestamp,
					date,
					domains: event.domains.join(", "),
					status: "success",
					type: "build",
				},
				email: {
					subject: "Build success for Panara Cloud",
					html: renderEmailHtml({
						status: "success",
						preview: `Build success for ${event.applicationName}`,
						heading: `Build success for ${event.applicationName}`,
						intro: `Your build for ${event.applicationName} was successful.`,
						details: [
							{ label: "Project Name", value: event.projectName },
							{ label: "Application Name", value: event.applicationName },
							{ label: "Environment", value: event.environmentName },
							{ label: "Application Type", value: event.applicationType },
							{ label: "Date", value: date },
						],
						button: { url: event.buildLink, label: "View build" },
					}),
				},
			};
		}
		case "appBuildError":
			return {
				...base,
				title: "Build Failed",
				emoji: "⚠️",
				status: "error",
				shortcode: "warning",
				facts: [
					{ label: "Project", value: event.projectName, emoji: "🛠️" },
					{ label: "Application", value: event.applicationName, emoji: "⚙️" },
					{ label: "Type", value: event.applicationType, emoji: "❔" },
					{ label: "Date", value: date, emoji: "📅" },
				],
				errorText: event.errorMessage,
				link: { url: event.buildLink, label: "View Build Details" },
				custom: {
					title: "Build Error",
					message: "Build failed with errors",
					projectName: event.projectName,
					applicationName: event.applicationName,
					applicationType: event.applicationType,
					errorMessage: event.errorMessage,
					buildLink: event.buildLink,
					timestamp,
					date,
					status: "error",
					type: "build",
				},
				email: {
					subject: "Build failed for Panara Cloud",
					html: renderEmailHtml({
						preview: `Build failed for ${event.applicationName}`,
						heading: `Build failed for ${event.applicationName}`,
						intro: `Your build for ${event.applicationName} failed. Please check the error message below.`,
						details: [
							{ label: "Project Name", value: event.projectName },
							{ label: "Application Name", value: event.applicationName },
							{ label: "Application Type", value: event.applicationType },
							{ label: "Date", value: date },
						],
						reason: { label: "Reason", text: event.errorMessage },
						button: { url: event.buildLink, label: "View build" },
					}),
				},
			};
		case "databaseBackup": {
			const ok = event.status === "success";
			const title = `Database Backup ${statusWord(event.status)}`;
			return {
				...base,
				title,
				emoji: ok ? "✅" : "❌",
				status: ok ? "success" : "error",
				shortcode: ok ? "white_check_mark" : "x",
				facts: [
					{ label: "Project", value: event.projectName, emoji: "🛠️" },
					{ label: "Application", value: event.applicationName, emoji: "⚙️" },
					{ label: "Database", value: event.databaseType, emoji: "❔" },
					{ label: "Database Name", value: event.databaseName, emoji: "📂" },
					{ label: "Date", value: date, emoji: "📅" },
				],
				errorText: ok ? undefined : event.errorMessage || "Unknown error",
				custom: {
					title,
					message: ok
						? "Database backup completed successfully"
						: "Database backup failed",
					projectName: event.projectName,
					applicationName: event.applicationName,
					databaseType: event.databaseType,
					databaseName: event.databaseName,
					type: event.status,
					errorMessage: event.errorMessage ?? "",
					timestamp,
					date,
					status: event.status,
				},
				email: {
					subject: "Database backup for Panara Cloud",
					html: renderEmailHtml({
						preview: `Database backup for ${event.applicationName} was ${ok ? "successful ✅" : "failed ❌"}`,
						heading: `Database backup for ${event.applicationName}`,
						intro: `Your database backup for ${event.applicationName} was ${ok ? "successful ✅" : "failed. Please check the error message below. ❌"}`,
						details: [
							{ label: "Project Name", value: event.projectName },
							{ label: "Application Name", value: event.applicationName },
							{ label: "Database Type", value: event.databaseType },
							{ label: "Database Name", value: event.databaseName },
							{ label: "Date", value: date },
						],
						reason: ok
							? undefined
							: {
									label: "Reason",
									text: event.errorMessage || "Error message not provided",
								},
					}),
				},
			};
		}
		case "volumeBackup": {
			const ok = event.status === "success";
			const title = `Volume Backup ${statusWord(event.status)}`;
			const facts: Fact[] = [
				{ label: "Project", value: event.projectName, emoji: "🛠️" },
				{ label: "Application", value: event.applicationName, emoji: "⚙️" },
				{ label: "Volume Name", value: event.volumeName, emoji: "💾" },
				{ label: "Service Type", value: event.serviceType, emoji: "🔧" },
			];
			if (event.backupSize) {
				facts.push({
					label: "Backup Size",
					value: event.backupSize,
					emoji: "📊",
				});
			}
			facts.push({ label: "Date", value: date, emoji: "📅" });
			return {
				...base,
				title,
				emoji: ok ? "✅" : "❌",
				status: ok ? "success" : "error",
				shortcode: ok ? "white_check_mark" : "x",
				facts,
				errorText: ok ? undefined : event.errorMessage || "Unknown error",
				custom: {
					title,
					message: ok
						? "Volume backup completed successfully"
						: "Volume backup failed",
					projectName: event.projectName,
					applicationName: event.applicationName,
					volumeName: event.volumeName,
					serviceType: event.serviceType,
					type: event.status,
					errorMessage: event.errorMessage ?? "",
					backupSize: event.backupSize ?? "",
					timestamp,
					date,
					status: event.status,
				},
				email: {
					subject: `${title} - ${event.applicationName}`,
					html: renderEmailHtml({
						preview: `Volume backup for ${event.applicationName} was ${ok ? "successful ✅" : "failed ❌"}`,
						heading: `Volume backup for ${event.applicationName}`,
						intro: `Your volume backup for ${event.applicationName} was ${ok ? "successful ✅" : "failed. Please check the error message below. ❌"}`,
						details: [
							{ label: "Project Name", value: event.projectName },
							{ label: "Application Name", value: event.applicationName },
							{ label: "Volume Name", value: event.volumeName },
							{ label: "Service Type", value: event.serviceType },
							...(event.backupSize
								? [{ label: "Backup Size", value: event.backupSize }]
								: []),
							{ label: "Date", value: date },
						],
						reason: ok
							? undefined
							: {
									label: "Reason",
									text: event.errorMessage || "Error message not provided",
								},
					}),
				},
			};
		}
		case "dockerCleanup":
			return {
				...base,
				title: "Docker Cleanup",
				emoji: "✅",
				status: "success",
				shortcode: "white_check_mark",
				facts: [
					{ label: "Date", value: date, emoji: "📅" },
					{ label: "Message", value: event.message, emoji: "📜" },
				],
				custom: {
					title: "Docker Cleanup",
					message: "Docker cleanup completed successfully",
					cleanupMessage: event.message,
					timestamp,
					date,
					status: "success",
					type: "docker-cleanup",
				},
				email: {
					subject: "Docker cleanup for Panara Cloud",
					html: renderEmailHtml({
						preview: "Docker cleanup for Panara Cloud",
						heading: "Docker cleanup for Panara Cloud",
						intro: "The docker cleanup for Panara Cloud was successful ✅",
						details: [
							{ label: "Message", value: event.message },
							{ label: "Date", value: date },
						],
					}),
				},
			};
		case "serverThreshold": {
			const at = formatDate(event.timestamp);
			const title = `Server ${event.metric} Alert`;
			return {
				...base,
				date: at,
				timestamp: new Date(event.timestamp).toISOString(),
				title,
				emoji: "⚠️",
				status: "warning",
				shortcode: "warning",
				facts: [
					{ label: "Server Name", value: event.serverName, emoji: "🏷️" },
					{ label: "Type", value: event.metric, emoji: "📊" },
					{
						label: "Current Value",
						value: `${event.value.toFixed(2)}%`,
						emoji: event.metric === "CPU" ? "🔲" : "💾",
					},
					{
						label: "Threshold",
						value: `${event.threshold.toFixed(2)}%`,
						emoji: "⚠️",
					},
					{ label: "Time", value: at, emoji: "🕒" },
					{ label: "Message", value: event.message, emoji: "💬" },
				],
				custom: {
					title,
					message: event.message,
					serverName: event.serverName,
					type: event.metric,
					currentValue: event.value,
					threshold: event.threshold,
					timestamp: new Date(event.timestamp).toISOString(),
					date: at,
					status: "alert",
					alertType: "server-threshold",
				},
				email: {
					subject: `Server ${event.metric} alert for ${event.serverName}`,
					html: renderEmailHtml({
						status: "warning",
						preview: `Server ${event.metric} alert for ${event.serverName}`,
						heading: `Server ${event.metric} alert for ${event.serverName}`,
						intro: `The ${event.metric} usage on ${event.serverName} exceeded the configured threshold.`,
						details: [
							{ label: "Server Name", value: event.serverName },
							{ label: "Type", value: event.metric },
							{ label: "Current Value", value: `${event.value}%` },
							{ label: "Threshold", value: `${event.threshold}%` },
							{ label: "Date", value: at },
						],
						reason: { label: "Message", text: event.message },
					}),
				},
			};
		}
		case "panelRestart":
			return {
				...base,
				title: "Panara Cloud Server Restarted",
				emoji: "✅",
				status: "success",
				shortcode: "white_check_mark",
				facts: [
					{ label: "Status", value: "Successful", emoji: "✅" },
					{ label: "Restart Time", value: date, emoji: "📅" },
				],
				custom: {
					title: "Panara Cloud Server Restarted",
					message: "Panara Cloud server has been restarted successfully",
					timestamp,
					date,
					status: "success",
					type: "panel-restart",
				},
				email: {
					subject: "Panara Cloud Server Restarted",
					html: renderEmailHtml({
						preview: "Your Panara Cloud server was restarted",
						heading: "Panara Cloud Server Restart",
						intro: "Your Panara Cloud server was restarted ✅",
						details: [{ label: "Date", value: date }],
					}),
				},
			};
		case "panelBackup": {
			const ok = event.status === "success";
			const title = `Panara Cloud Backup ${statusWord(event.status)}`;
			const facts: Fact[] = [
				{
					label: "Backup Type",
					value: "Complete Panara Cloud Instance",
					emoji: "📦",
				},
			];
			if (event.backupSize) {
				facts.push({
					label: "Backup Size",
					value: event.backupSize,
					emoji: "📊",
				});
			}
			facts.push(
				{ label: "Date", value: date, emoji: "📅" },
				{
					label: "Status",
					value: statusWord(event.status),
					emoji: ok ? "✅" : "❌",
				},
			);
			return {
				...base,
				title,
				emoji: ok ? "✅" : "❌",
				status: ok ? "success" : "error",
				shortcode: ok ? "white_check_mark" : "x",
				facts,
				errorText: ok ? undefined : event.errorMessage,
				custom: {
					title,
					message: `Panara Cloud instance backup ${ok ? "completed successfully" : "failed"}`,
					backupType: "Complete Panara Cloud Instance",
					...(event.backupSize ? { backupSize: event.backupSize } : {}),
					...(!ok && event.errorMessage
						? { errorMessage: event.errorMessage }
						: {}),
					timestamp,
					date,
					status: event.status,
					type: "panel-backup",
				},
				email: {
					subject: "Panara Cloud instance backup",
					html: renderEmailHtml({
						preview: `Panara Cloud instance backup was ${ok ? "successful ✅" : "failed ❌"}`,
						heading: "Panara Cloud Instance Backup",
						intro: `Your Panara Cloud instance backup was ${ok ? "successful ✅" : "failed ❌"}`,
						details: [
							{ label: "Backup Type", value: "Complete Panara Cloud Instance" },
							...(event.backupSize
								? [{ label: "Backup Size", value: event.backupSize }]
								: []),
							{ label: "Date", value: date },
							{ label: "Status", value: statusWord(event.status) },
						],
						reason: ok
							? undefined
							: {
									label: "Reason",
									text: event.errorMessage || "Error message not provided",
								},
					}),
				},
			};
		}
	}
};

export const TEST_TEXT = "Hi, From Panara Cloud 👋";

export const buildTestMessage = (sentAt: number): NotificationMessage => ({
	title: "Test Notification",
	emoji: "👋",
	status: "success",
	shortcode: "wave",
	facts: [{ label: "Message", value: TEST_TEXT, emoji: "💬" }],
	custom: {
		title: "Test Notification",
		message: TEST_TEXT,
		timestamp: new Date(sentAt).toISOString(),
	},
	email: {
		subject: "Test Email",
		html: renderEmail({
			preview: TEST_TEXT,
			title: "Test notification",
			intro: TEST_TEXT,
			status: "success",
			footer: NOTIFICATION_FOOTER,
		}),
	},
	date: formatDate(sentAt),
	timestamp: new Date(sentAt).toISOString(),
});

const ERROR_LIMIT = 800;

const COLORS: Record<Status, { discord: number; hex: string; lark: string }> = {
	success: { discord: 0x57f287, hex: "#00FF00", lark: "green" },
	error: { discord: 0xed4245, hex: "#FF0000", lark: "red" },
	warning: { discord: 0xff0000, hex: "#FF0000", lark: "orange" },
};

export const toSlack = (message: NotificationMessage, channel?: string) => ({
	channel,
	attachments: [
		{
			color: COLORS[message.status].hex,
			pretext: `:${message.shortcode}: *${message.title}*`,
			fields: [
				...message.facts.map((f) => ({
					title: f.label,
					value: f.value,
					short: true,
				})),
				...(message.errorText
					? [
							{
								title: "Error",
								value: `\`\`\`${message.errorText}\`\`\``,
								short: false,
							},
						]
					: []),
				...(message.link
					? [
							{
								title: "Details",
								value: `<${message.link.url}|${message.link.label}>`,
								short: false,
							},
						]
					: []),
			],
			mrkdwn_in: ["fields"],
		},
	],
});

export const toDiscord = (
	message: NotificationMessage,
	decoration: boolean,
) => {
	const decorate = (prefix: string, text: string) =>
		`${decoration ? prefix : ""} ${text}`.trim();
	return {
		title: decorate(">", `\`${message.emoji}\` ${message.title}`),
		color: COLORS[message.status].discord,
		fields: [
			...message.facts.map((f) => ({
				name: decorate(`\`${f.emoji}\``, f.label),
				value: f.value,
				inline: true,
			})),
			...(message.errorText
				? [
						{
							name: decorate("`⚠️`", "Error Message"),
							value: `\`\`\`${message.errorText.substring(0, ERROR_LIMIT)}\`\`\``,
						},
					]
				: []),
			...(message.link
				? [
						{
							name: decorate("`🧷`", message.link.label),
							value: `[Click here to access build link](${message.link.url})`,
						},
					]
				: []),
		],
		timestamp: message.timestamp,
		footer: { text: "Panara Cloud Notification" },
	};
};

export const toTelegram = (message: NotificationMessage) => {
	const lines = message.facts.map(
		(f) => `<b>${escapeHtml(f.label)}:</b> ${escapeHtml(f.value)}`,
	);
	const error = message.errorText
		? `\n\n<b>Error:</b>\n<pre>${formatTelegramErrorMessage(message.errorText)}</pre>`
		: "";
	return {
		text: `<b>${message.emoji} ${escapeHtml(message.title)}</b>\n\n${lines.join("\n")}${error}`,
		buttons: message.link
			? [[{ text: message.link.label, url: message.link.url }]]
			: undefined,
	};
};

const plainLines = (message: NotificationMessage, decorate: boolean) => {
	const prefix = (emoji: string) => (decorate ? `${emoji} ` : "");
	const lines = message.facts.map(
		(f) => `${prefix(f.emoji)}${f.label}: ${f.value}`,
	);
	if (message.errorText)
		lines.push(`${prefix("⚠️")}Error:\n${message.errorText}`);
	if (message.link)
		lines.push(`${prefix("🔗")}${message.link.label}:\n${message.link.url}`);
	return lines.join("\n");
};

export const toGotify = (
	message: NotificationMessage,
	decoration: boolean,
) => ({
	title: `${decoration ? `${message.emoji} ` : ""}${message.title}`,
	message: plainLines(message, decoration),
});

export const toNtfy = (message: NotificationMessage) => ({
	title: message.title,
	tags: message.shortcode,
	actions: message.link
		? `view, ${message.link.label}, ${message.link.url}, clear=true;`
		: "",
	message: plainLines(message, true),
});

export const toMattermost = (
	message: NotificationMessage,
	channel: string | undefined,
	username: string | undefined,
) => {
	const facts = message.facts
		.map((f) => `**${f.label}:** ${f.value}`)
		.join("\n");
	const error = message.errorText
		? `\n\n**Error:**\n\`\`\`\n${message.errorText}\n\`\`\``
		: "";
	const link = message.link
		? `\n\n[${message.link.label}](${message.link.url})`
		: "";
	return {
		text: `:${message.shortcode}: **${message.title}**\n\n${facts}${error}${link}`,
		...(channel?.trim() ? { channel: `#${channel.replace("#", "")}` } : {}),
		username: username?.trim() || "Panara Cloud Bot",
	};
};

export const toPushover = (message: NotificationMessage) => ({
	title: message.title,
	message: plainLines(message, false),
});

export const toTeams = (message: NotificationMessage) => {
	const body: Record<string, unknown>[] = [
		{
			type: "TextBlock",
			text: `${message.emoji} ${message.title}`,
			size: "Medium",
			weight: "Bolder",
			wrap: true,
		},
	];
	const facts = [
		...message.facts.map((f) => ({ title: f.label, value: f.value })),
		...(message.errorText
			? [
					{
						title: "Error Message",
						value: message.errorText.substring(0, ERROR_LIMIT),
					},
				]
			: []),
	];
	if (facts.length > 0) body.push({ type: "FactSet", facts });
	const card: Record<string, unknown> = {
		type: "AdaptiveCard",
		$schema: "http://adaptivecards.io/schemas/adaptive-card.json",
		version: "1.4",
		body,
	};
	if (message.link) {
		card.actions = [
			{
				type: "Action.OpenUrl",
				title: message.link.label,
				url: message.link.url,
			},
		];
	}
	return {
		type: "message",
		attachments: [
			{ contentType: "application/vnd.microsoft.card.adaptive", content: card },
		],
	};
};

export const toLark = (message: NotificationMessage) => {
	const markdown = (content: string) => ({
		tag: "markdown",
		content,
		text_align: "left",
		text_size: "normal_v2",
	});
	const left = message.facts.filter((_, i) => i % 2 === 0);
	const right = message.facts.filter((_, i) => i % 2 === 1);
	const column = (facts: Fact[]) => ({
		tag: "column",
		width: "weighted",
		elements: facts.map((f) => markdown(`**${f.label}:**\n${f.value}`)),
		vertical_align: "top",
		weight: 1,
	});
	const elements: Record<string, unknown>[] = [
		{ tag: "column_set", columns: [column(left), column(right)] },
	];
	if (message.errorText) {
		elements.push(
			markdown(
				`**Error Message:**\n\`\`\`\n${message.errorText.substring(0, ERROR_LIMIT)}\n\`\`\``,
			),
		);
	}
	if (message.link) {
		elements.push({
			tag: "button",
			text: { tag: "plain_text", content: message.link.label },
			type: message.status === "error" ? "danger" : "primary",
			width: "default",
			size: "medium",
			behaviors: [{ type: "open_url", default_url: message.link.url }],
		});
	}
	return {
		msg_type: "interactive",
		card: {
			schema: "2.0",
			config: { update_multi: true },
			header: {
				title: {
					tag: "plain_text",
					content: `${message.emoji} ${message.title}`,
				},
				template: COLORS[message.status].lark,
				padding: "12px 12px 12px 12px",
			},
			body: {
				direction: "vertical",
				padding: "12px 12px 12px 12px",
				elements,
			},
		},
	};
};

export type ChannelRequest =
	| { kind: "fetch"; url: string; init: RequestInit }
	| {
			kind: "smtp";
			host: string;
			port: number;
			username: string;
			password: string;
			from: string;
			to: string[];
			subject: string;
			html: string;
	  };

const json = (
	body: unknown,
	headers: Record<string, string> = {},
): RequestInit => ({
	method: "POST",
	headers: { "Content-Type": "application/json", ...headers },
	body: JSON.stringify(body),
});

const trimSlash = (url: string) => url.replace(/\/+$/, "");

export const buildChannelRequest = (
	channel: NotificationChannel,
	credentials: Credentials,
	message: NotificationMessage,
): ChannelRequest => {
	switch (channel.type) {
		case "slack":
			return {
				kind: "fetch",
				url: credentials.webhookUrl,
				init: json(toSlack(message, channel.channel)),
			};
		case "discord":
			return {
				kind: "fetch",
				url: credentials.webhookUrl,
				init: json({ embeds: [toDiscord(message, channel.decoration)] }),
			};
		case "telegram": {
			const { text, buttons } = toTelegram(message);
			return {
				kind: "fetch",
				url: `https://api.telegram.org/bot${credentials.botToken}/sendMessage`,
				init: json({
					chat_id: channel.chatId,
					message_thread_id: channel.messageThreadId,
					text,
					parse_mode: "HTML",
					disable_web_page_preview: true,
					reply_markup: { inline_keyboard: buttons },
				}),
			};
		}
		case "email":
			return {
				kind: "smtp",
				host: channel.smtpServer,
				port: channel.smtpPort,
				username: channel.username,
				password: credentials.password,
				from: channel.fromAddress,
				to: channel.toAddresses,
				subject: message.email.subject,
				html: message.email.html,
			};
		case "resend":
			return {
				kind: "fetch",
				url: "https://api.resend.com/emails",
				init: json(
					{
						from: channel.fromAddress,
						to: channel.toAddresses,
						subject: message.email.subject,
						html: message.email.html,
					},
					{ Authorization: `Bearer ${credentials.apiKey}` },
				),
			};
		case "gotify": {
			const { title, message: text } = toGotify(message, channel.decoration);
			return {
				kind: "fetch",
				url: `${trimSlash(channel.serverUrl)}/message`,
				init: json(
					{
						title,
						message: text,
						priority: channel.priority,
						extras: { "client::display": { contentType: "text/plain" } },
					},
					{ "X-Gotify-Key": credentials.appToken },
				),
			};
		}
		case "ntfy": {
			const ntfy = toNtfy(message);
			return {
				kind: "fetch",
				url: `${trimSlash(channel.serverUrl)}/${encodeURIComponent(channel.topic)}`,
				init: {
					method: "POST",
					headers: {
						...(credentials.accessToken
							? { Authorization: `Bearer ${credentials.accessToken}` }
							: {}),
						"X-Priority": String(channel.priority),
						// HTTP header values must be Latin-1; ntfy decodes RFC 2047.
						"X-Title": encodeHeader(ntfy.title),
						"X-Tags": ntfy.tags,
						...(ntfy.actions
							? { "X-Actions": encodeHeader(ntfy.actions) }
							: {}),
					},
					body: ntfy.message,
				},
			};
		}
		case "mattermost":
			return {
				kind: "fetch",
				url: credentials.webhookUrl,
				init: json(toMattermost(message, channel.channel, channel.username)),
			};
		case "pushover": {
			const { title, message: text } = toPushover(message);
			const form = new URLSearchParams({
				token: credentials.apiToken,
				user: credentials.userKey,
				title,
				message: text,
				priority: String(channel.priority),
			});
			if (channel.priority === 2) {
				form.append("retry", String(channel.retry ?? 30));
				form.append("expire", String(channel.expire ?? 3600));
			}
			return {
				kind: "fetch",
				url: "https://api.pushover.net/1/messages.json",
				init: {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: form.toString(),
				},
			};
		}
		case "custom":
			return {
				kind: "fetch",
				url: channel.endpoint,
				init: json(message.custom, parseCustomHeaders(credentials.headers)),
			};
		case "lark":
			return {
				kind: "fetch",
				url: credentials.webhookUrl,
				init: json(toLark(message)),
			};
		case "teams":
			return {
				kind: "fetch",
				url: credentials.webhookUrl,
				init: json(toTeams(message)),
			};
	}
};

const encodeHeader = (value: string) =>
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Latin-1 range check
	/^[\x00-\xff]*$/.test(value)
		? value
		: `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(value)))}?=`;
