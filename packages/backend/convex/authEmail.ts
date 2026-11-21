import { Resend } from "@convex-dev/resend";
import { ConvexError, type Infer, v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import { deliveryMode, logAuthLinks } from "./email";
import { renderEmail } from "./lib/emailLayout";

export const authEmailArgs = v.object({
	to: v.string(),
	kind: v.union(
		v.literal("verify"),
		v.literal("reset"),
		v.literal("change-email"),
		v.literal("invite"),
	),
	url: v.string(),
	organizationName: v.optional(v.string()),
	inviterName: v.optional(v.string()),
	newEmail: v.optional(v.string()),
});

export type AuthEmail = Infer<typeof authEmailArgs>;

// Resend stays in test mode (only Resend's test inboxes receive mail) until
// RESEND_TEST_MODE=false, so a fresh install can't email real people by
// accident.
export const resend = new Resend(components.resend, {
	testMode: process.env.RESEND_TEST_MODE !== "false",
});

export const authEmailContent = (email: Omit<AuthEmail, "to">) => {
	const content = {
		verify: {
			subject: "Verify your email",
			intro: "Confirm your email address to start using Panara Cloud.",
			action: "Verify email",
		},
		reset: {
			subject: "Reset your password",
			intro:
				"Someone asked to reset the password for your Panara Cloud account. If it wasn't you, ignore this email.",
			action: "Choose a new password",
		},
		"change-email": {
			subject: "Confirm your email change",
			intro: `Confirm that your Panara Cloud account should use ${email.newEmail ?? "a new email address"} from now on.`,
			action: "Confirm change",
		},
		invite: {
			subject: `Join ${email.organizationName ?? "your team"} on Panara Cloud`,
			intro: `${email.inviterName ?? "A teammate"} invited you to ${email.organizationName ?? "their team"} on Panara Cloud.`,
			action: "Accept invitation",
		},
	}[email.kind];
	return {
		subject: content.subject,
		text: `${content.intro}\n\n${content.action}: ${email.url}\n`,
		html: renderEmail({
			preview: content.intro,
			title: content.subject,
			intro: content.intro,
			button: { url: email.url, label: content.action },
			note: "If you didn't expect this email, you can ignore it.",
			footer:
				"You received this email because this address was used on a Panara Cloud panel.",
		}),
	};
};

// RFC 2606/6761 names that can never receive mail. Test suites sign up with
// them; sending would only produce bounces that hurt the sending domain.
const UNDELIVERABLE =
	/(\.test|\.example|\.invalid|\.localhost|@example\.(com|net|org))$/i;

export const NO_EMAIL_MESSAGES: Record<AuthEmail["kind"], string> = {
	verify:
		"This Panara Cloud instance doesn't send email, so it can't verify this address. Create your account from your invitation link, or ask an administrator to connect an email provider.",
	reset:
		"This Panara Cloud instance doesn't send email. Ask an administrator for a password reset link.",
	"change-email":
		"This Panara Cloud instance doesn't send email; change your email from the account page instead.",
	invite: "",
};

// Sends one account email through the instance's delivery mode (email.ts).
// Without any provider, invitations are not mailed (the inviter copies the
// link) and every other kind fails with a message saying what to do instead.
export const send = internalMutation({
	args: authEmailArgs.fields,
	handler: async (ctx, email) => {
		const logLinks = logAuthLinks();
		if (logLinks) {
			console.log(
				JSON.stringify({
					event: "auth.email",
					kind: email.kind,
					to: email.to,
					url: email.url,
				}),
			);
		}
		const mode = await deliveryMode(ctx);
		if (mode === "none") {
			if (email.kind === "invite") return;
			throw new ConvexError(NO_EMAIL_MESSAGES[email.kind]);
		}
		if (UNDELIVERABLE.test(email.to.trim())) {
			if (logLinks) return;
			throw new ConvexError(`${email.to} cannot receive email`);
		}
		if (mode === "log") return;
		const content = authEmailContent(email);
		if (mode === "provider") {
			await ctx.scheduler.runAfter(0, internal.email.deliver, {
				mail: {
					to: email.to,
					subject: content.subject,
					html: content.html,
					text: content.text,
				},
				idempotencyKey: crypto.randomUUID(),
			});
			return;
		}
		await resend.sendEmail(ctx, {
			from: process.env.AUTH_EMAIL_FROM ?? "",
			to: email.to,
			subject: content.subject,
			html: content.html,
			text: content.text,
		});
	},
});

export const INVITATION_REQUIRED =
	"This Panara Cloud instance is invitation-only, and this email address has no pending invitation. Ask an administrator for an invitation link.";

// Consulted before Better Auth inserts a sign-up (auth.ts). Decides whether
// the account starts verified: the first account of an instance that can't
// send email, and any account created from its open invitation link. Every
// other sign-up needs a pending invitation for its email, and, without email,
// is refused up front since nothing could verify it.
export const signupPolicy = internalQuery({
	args: { email: v.string(), invitationId: v.optional(v.string()) },
	returns: v.object({
		verified: v.boolean(),
		refusal: v.union(
			v.object({
				code: v.union(
					v.literal("INVITATION_REQUIRED"),
					v.literal("EMAIL_UNAVAILABLE"),
				),
				message: v.string(),
			}),
			v.null(),
		),
		// The first account: the sign-up must carry the installer's setup token.
		setup: v.boolean(),
	}),
	handler: async (ctx, { email, invitationId }) => {
		const first = await ctx.runQuery(
			components.betterAuth.policy.registrationOpen,
			{},
		);
		if (
			!first &&
			invitationId &&
			(await ctx.runQuery(components.betterAuth.policy.invitationOpen, {
				invitationId,
				email,
			}))
		) {
			return { verified: true, refusal: null, setup: false };
		}
		const mode = await deliveryMode(ctx);
		if (first) return { verified: mode === "none", refusal: null, setup: true };
		if (
			!(await ctx.runQuery(components.betterAuth.policy.invited, { email }))
		) {
			return {
				verified: false,
				refusal: {
					code: "INVITATION_REQUIRED" as const,
					message: INVITATION_REQUIRED,
				},
				setup: false,
			};
		}
		if (mode === "none") {
			return {
				verified: false,
				refusal: {
					code: "EMAIL_UNAVAILABLE" as const,
					message: NO_EMAIL_MESSAGES.verify,
				},
				setup: false,
			};
		}
		return { verified: false, refusal: null, setup: false };
	},
});
