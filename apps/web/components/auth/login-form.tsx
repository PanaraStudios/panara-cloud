"use client";

import { KeyRoundIcon, MailCheckIcon, UserPlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useEmailEnabled } from "@/components/email/copy-link";
import { Button, buttonVariants } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { AuthError, authClient, authResult } from "@/lib/auth/client";
import { authMessage } from "@/lib/auth/errors";
import { useRouter, useSearchParams } from "@/lib/router";
import Link from "@/lib/router/link";
import {
	AuthHeading,
	AuthTextLink,
	FormError,
	FormSuccess,
	TextField,
	useNext,
} from "./ui";

const notices: Record<string, string> = {
	reset: "Your password was changed. Sign in with your new password.",
	reauth: "For your security, sign in again to continue.",
	"signed-out": "You've been signed out.",
};

function passkeyMessage(error: { message?: string; code?: string }) {
	if (/cancel|not allowed|abort|timed out/i.test(error.message ?? "")) {
		return "The passkey request was cancelled or no passkey was found for this site.";
	}
	return authMessage(new AuthError(error.message ?? "", error.code));
}

export function LoginForm() {
	const router = useRouter();
	const params = useSearchParams();
	const { next, link } = useNext();
	const [pending, setPending] = useState<"password" | "passkey" | null>(null);
	const [error, setError] = useState("");
	const [unverified, setUnverified] = useState("");
	const emailEnabled = useEmailEnabled();
	const notice = notices[params.get("notice") ?? ""];

	useEffect(() => {
		let active = true;
		const autofill = async () => {
			if (
				typeof PublicKeyCredential === "undefined" ||
				!(await PublicKeyCredential.isConditionalMediationAvailable?.())
			) {
				return;
			}
			// Resolves only when the user picks a passkey from the email field's
			// autofill menu; a later explicit passkey request aborts it.
			const result = await authClient.signIn.passkey({ autoFill: true });
			if (active && result?.data) window.location.assign(next);
		};
		autofill().catch(() => {});
		return () => {
			active = false;
		};
	}, [next]);

	async function signInWithPasskey() {
		setPending("passkey");
		setError("");
		setUnverified("");
		const result = await authClient.signIn.passkey();
		if (result?.error) {
			setError(passkeyMessage(result.error));
			setPending(null);
			return;
		}
		window.location.assign(next);
	}

	return (
		<div className="flex flex-col gap-6">
			<AuthHeading
				title="Sign in"
				description="Welcome back. Your servers missed you."
			/>
			<FormSuccess>{notice}</FormSuccess>
			<form
				method="post"
				className="flex flex-col gap-5"
				onSubmit={async (event) => {
					event.preventDefault();
					const data = new FormData(event.currentTarget);
					const email = String(data.get("email") ?? "")
						.trim()
						.toLowerCase();
					setPending("password");
					setError("");
					setUnverified("");
					try {
						const result = await authResult(
							authClient.signIn.email({
								email,
								password: String(data.get("password") ?? ""),
								callbackURL: next,
							}),
						);
						if ("twoFactorRedirect" in result && result.twoFactorRedirect) {
							router.push(link("/mfa"));
							return;
						}
						window.location.assign(next);
					} catch (error) {
						if (
							error instanceof AuthError &&
							error.code === "EMAIL_NOT_VERIFIED"
						) {
							setUnverified(email);
						} else {
							setError(authMessage(error));
						}
						setPending(null);
					}
				}}
			>
				<FieldGroup>
					<TextField
						label="Email"
						name="email"
						type="email"
						autoComplete="username webauthn"
						required
					/>
					<TextField
						label="Password"
						name="password"
						type="password"
						autoComplete="current-password"
						required
						action={
							<AuthTextLink
								href={link("/forgot-password")}
								icon={KeyRoundIcon}
								size="xs"
							>
								Forgot password?
							</AuthTextLink>
						}
					/>
				</FieldGroup>
				<FormError>{error}</FormError>
				{unverified && emailEnabled === false && (
					<p role="alert" className="text-sm">
						Your email address isn&apos;t verified and this instance
						doesn&apos;t send email. Ask an administrator for a password reset
						link (Settings → Members): using it verifies your address.
					</p>
				)}
				{unverified && emailEnabled !== false && (
					<div role="alert" className="flex flex-col gap-3 text-sm">
						<p>
							Your email address isn&apos;t verified yet. We sent a new
							verification link to <strong>{unverified}</strong>.
						</p>
						<Link
							href={link("/verify-email", { email: unverified })}
							className={buttonVariants({ variant: "outline", size: "sm" })}
						>
							<MailCheckIcon data-icon="inline-start" />
							Resend verification email
						</Link>
					</div>
				)}
				<Button type="submit" size="lg" disabled={pending !== null}>
					{pending === "password" ? "Signing in…" : "Sign in"}
				</Button>
			</form>
			<div className="flex items-center gap-3" aria-hidden="true">
				<Separator className="flex-1" />
				<span className="text-xs text-muted-foreground">or</span>
				<Separator className="flex-1" />
			</div>
			<Button
				type="button"
				variant="outline"
				size="lg"
				disabled={pending !== null}
				onClick={signInWithPasskey}
			>
				<KeyRoundIcon data-icon="inline-start" />
				{pending === "passkey"
					? "Waiting for passkey…"
					: "Sign in with a passkey"}
			</Button>
			<nav
				aria-label="Account options"
				className="flex flex-col items-center gap-2"
			>
				<div className="flex flex-wrap items-center justify-center gap-1 text-sm text-muted-foreground">
					<span>New here?</span>
					<AuthTextLink href={link("/signup")} icon={UserPlusIcon}>
						Create an account
					</AuthTextLink>
				</div>
			</nav>
		</div>
	);
}
