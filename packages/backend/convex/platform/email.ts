import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { type ActionCtx, internalAction } from "../_generated/server";
import { providerFetch } from "./lib/fetch";
import { invitationEmail } from "./lib/notificationMessages";

type Mail = { to: string; subject: string; html: string; text?: string };

// Instance mail settings come from env vars: SMTP_SERVER,
// SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD, SMTP_FROM_ADDRESS, or
// RESEND_API_KEY with EMAIL_FROM_ADDRESS.
export const isInstanceEmailConfigured = () =>
	Boolean(
		(process.env.SMTP_SERVER && process.env.SMTP_FROM_ADDRESS) ||
			(process.env.RESEND_API_KEY && process.env.EMAIL_FROM_ADDRESS),
	);

const sendInstanceEmail = async (ctx: ActionCtx, mail: Mail) => {
	const env = process.env;
	if (env.SMTP_SERVER && env.SMTP_FROM_ADDRESS) {
		await ctx.runAction(internal.platform.notificationsNode.sendSmtp, {
			host: env.SMTP_SERVER,
			port: Number(env.SMTP_PORT ?? 587),
			username: env.SMTP_USERNAME ?? "",
			password: env.SMTP_PASSWORD ?? "",
			from: env.SMTP_FROM_ADDRESS,
			to: [mail.to],
			subject: mail.subject,
			html: mail.html,
			text: mail.text,
		});
		return;
	}
	if (env.RESEND_API_KEY && env.EMAIL_FROM_ADDRESS) {
		const response = await providerFetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${env.RESEND_API_KEY}`,
			},
			body: JSON.stringify({
				from: env.EMAIL_FROM_ADDRESS,
				to: [mail.to],
				subject: mail.subject,
				html: mail.html,
				text: mail.text,
			}),
		});
		if (!response.ok) {
			throw new Error(
				`Resend rejected the email: ${response.status} ${await response.text().catch(() => "")}`,
			);
		}
		return;
	}
	throw new ConvexError(
		"Email is not configured: set SMTP_SERVER/SMTP_PORT/SMTP_USERNAME/SMTP_PASSWORD/SMTP_FROM_ADDRESS or RESEND_API_KEY/EMAIL_FROM_ADDRESS",
	);
};

export const sendTransactionalEmail = internalAction({
	args: {
		to: v.string(),
		subject: v.string(),
		html: v.string(),
		text: v.optional(v.string()),
	},
	handler: async (ctx, mail) => {
		await sendInstanceEmail(ctx, mail);
	},
});

export const sendInvitationEmail = internalAction({
	args: {
		email: v.string(),
		inviteLink: v.string(),
		organizationName: v.string(),
		inviterName: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const { subject, html, text } = invitationEmail(args);
		await sendInstanceEmail(ctx, { to: args.email, subject, html, text });
	},
});

// Builds sendInvitationEmail args from Better Auth's organization-plugin
// `sendInvitationEmail` callback data. The link points at the
// `/invitation?token=<invitationId>` page.
export const invitationEmailArgs = (
	data: {
		id: string;
		email: string;
		organization: { name: string };
		inviter: { user: { name?: string | null; email: string } };
	},
	siteUrl: string,
) => ({
	email: data.email,
	inviteLink: `${siteUrl.replace(/\/+$/, "")}/invitation?token=${encodeURIComponent(data.id)}`,
	organizationName: data.organization.name,
	inviterName: data.inviter.user.name || data.inviter.user.email,
});
