import { passkey } from "@better-auth/passkey";
import { convex } from "@convex-dev/better-auth/plugins";
import type { BetterAuthOptions } from "better-auth/minimal";
import { organization } from "better-auth/plugins/organization";
import { twoFactor } from "better-auth/plugins/two-factor";
import authConfig from "./auth.config";
import type { AuthEmail } from "./authEmail";

export const APP_NAME = "Panara Cloud";
export const MIN_PASSWORD_LENGTH = 12;

// Email verification tokens are JWTs; the second step of an email change
// carries requestType "change-email-verification". Only routes the email, so
// the payload is read without checking the signature (verify-email does).
export const isChangeEmailVerification = (token: string) => {
	try {
		const payload = token.split(".")[1] ?? "";
		const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
		const json = JSON.parse(
			atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
		);
		return json?.requestType === "change-email-verification";
	} catch {
		return false;
	}
};

export const siteUrl = () => process.env.SITE_URL ?? "http://localhost:3000";

// Shared by the runtime, the component adapter and the schema generator. Only
// the runtime passes a `sendEmail` that can reach the mailer.
export const createAuthOptions = (
	sendEmail: (email: AuthEmail) => Promise<void> = async () => {
		throw new Error("Account email requires the runtime mailer");
	},
	// Organizations are created by the instance administrator; everyone else
	// joins through an invitation.
	canCreateOrganization: (userId: string) => Promise<boolean> = async () =>
		false,
) => {
	const site = siteUrl();
	return {
		appName: APP_NAME,
		emailAndPassword: {
			enabled: true,
			requireEmailVerification: true,
			minPasswordLength: MIN_PASSWORD_LENGTH,
			maxPasswordLength: 128,
			revokeSessionsOnPasswordReset: true,
			resetPasswordTokenExpiresIn: 60 * 60,
			sendResetPassword: async ({ user, url }) =>
				sendEmail({ to: user.email, kind: "reset", url }),
		},
		emailVerification: {
			sendOnSignUp: true,
			sendOnSignIn: true,
			autoSignInAfterVerification: true,
			expiresIn: 24 * 60 * 60,
			// Accounts admitted without verification (auth.ts) skip the email.
			// A change of address still needs it: Better Auth passes the
			// (verified) account with its new email for the second step.
			sendVerificationEmail: async ({ user, url, token }) => {
				if (user.emailVerified && !isChangeEmailVerification(token)) return;
				await sendEmail({ to: user.email, kind: "verify", url });
			},
		},
		user: {
			changeEmail: {
				enabled: true,
				sendChangeEmailConfirmation: async ({ user, newEmail, url }) =>
					sendEmail({ to: user.email, kind: "change-email", url, newEmail }),
			},
		},
		// Sensitive changes (password, email, 2FA, passkeys) need a sign-in
		// from the last 5 minutes.
		session: { freshAge: 5 * 60, cookieCache: { enabled: false } },
		plugins: [
			organization({
				creatorRole: "owner",
				allowUserToCreateOrganization: async (user) =>
					await canCreateOrganization(user.id),
				sendInvitationEmail: async (data) =>
					sendEmail({
						to: data.email,
						kind: "invite",
						url: `${site}/invitation?id=${encodeURIComponent(data.id)}`,
						organizationName: data.organization.name,
						inviterName: data.inviter.user.name || data.inviter.user.email,
					}),
			}),
			twoFactor({ issuer: APP_NAME }),
			passkey({
				rpName: APP_NAME,
				rpID: new URL(site).hostname,
				origin: site,
			}),
			convex({ authConfig }),
		],
	} satisfies BetterAuthOptions;
};
