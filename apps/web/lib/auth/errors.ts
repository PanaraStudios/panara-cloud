import { ConvexError } from "convex/values";
import { AuthError } from "./client";

const messages: Record<string, string> = {
	INVALID_EMAIL_OR_PASSWORD: "The email or password is incorrect.",
	INVALID_PASSWORD: "The password is incorrect.",
	EMAIL_NOT_VERIFIED:
		"Verify your email address before signing in. We sent you a new verification link.",
	PASSWORD_TOO_SHORT: "Use a password with at least 12 characters.",
	PASSWORD_TOO_LONG: "Use a password with at most 128 characters.",
	USER_ALREADY_EXISTS:
		"An account with this email already exists. Sign in instead.",
	USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
		"Another account already uses this email address.",
	INVALID_TOKEN:
		"This link is invalid or has already been used. Request a new one.",
	TOKEN_EXPIRED: "This link has expired. Request a new one.",
	INVALID_CODE: "That code is incorrect or has expired. Try the next code.",
	INVALID_BACKUP_CODE:
		"That backup code is incorrect or has already been used.",
	INVALID_TWO_FACTOR_COOKIE:
		"Your sign-in attempt expired. Sign in with your password again.",
	TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE:
		"Too many attempts. Sign in with your password again.",
	ACCOUNT_TEMPORARILY_LOCKED:
		"Too many failed attempts. Your account is temporarily locked; try again later.",
	CREDENTIAL_ACCOUNT_NOT_FOUND: "This account doesn't have a password yet.",
	EMAIL_ALREADY_VERIFIED: "This email address is already verified.",
	SESSION_EXPIRED: "Your session expired. Sign in again.",
	INVITATION_NOT_FOUND:
		"This invitation has expired, was already accepted or declined, or was withdrawn.",
	YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION:
		"This invitation was sent to a different email address.",
	PASSKEY_NOT_FOUND: "This passkey isn't registered with your account.",
	ACCOUNT_DEACTIVATED:
		"This account has been deactivated. Ask your administrator to reactivate it.",
};

const NOT_FRESH = new Set([
	"SESSION_NOT_FRESH",
	"SESSION_EXPIRED",
	"UNAUTHORIZED",
]);

// Sensitive changes need a recent sign-in (session.freshAge on the backend).
export function needsReauth(error: unknown) {
	return (
		(error instanceof AuthError &&
			(NOT_FRESH.has(error.code ?? "") || /not fresh/i.test(error.message))) ||
		// Backend mutations that mirror Better Auth's fresh-session rule
		// (account.changeEmailWithoutConfirmation).
		(error instanceof ConvexError &&
			typeof error.data === "string" &&
			/needs a recent sign-in/i.test(error.data))
	);
}

export function authMessage(error: unknown): string {
	if (error instanceof AuthError) {
		if (error.status === 429) {
			return "Too many attempts. Wait a minute and try again.";
		}
		if (needsReauth(error)) {
			return "For your security, sign in again to make this change.";
		}
		if (error.code && messages[error.code]) return messages[error.code];
		return error.message;
	}
	if (error instanceof ConvexError) {
		return typeof error.data === "string"
			? error.data
			: "Something went wrong. Please try again.";
	}
	if (error instanceof DOMException && error.name === "NotAllowedError") {
		return "The passkey request was cancelled or timed out.";
	}
	if (error instanceof Error) return error.message;
	return "Something went wrong. Please try again.";
}

// Message for any failed Convex call or auth request, for toasts and alerts.
export const errorMessage = authMessage;
