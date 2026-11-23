import { passkeyClient } from "@better-auth/passkey/client";
import { convexClient } from "@convex-dev/better-auth/client/plugins";
import {
	organizationClient,
	twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
	plugins: [
		convexClient(),
		organizationClient(),
		twoFactorClient(),
		passkeyClient(),
	],
});

export class AuthError extends Error {
	constructor(
		message: string,
		readonly code?: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "AuthError";
	}
}

type AuthResponse<T> = {
	data: T;
	error: { message?: string; code?: string; status?: number } | null;
};

// Better Auth returns errors instead of throwing; unwrap so forms can use
// try/catch and map the error code to a helpful message.
export async function authResult<T>(
	response: Promise<AuthResponse<T>> | AuthResponse<T>,
): Promise<NonNullable<T>> {
	const { data, error } = await response;
	if (error) {
		throw new AuthError(
			error.message || "Something went wrong. Please try again.",
			error.code,
			error.status,
		);
	}
	return data as NonNullable<T>;
}
