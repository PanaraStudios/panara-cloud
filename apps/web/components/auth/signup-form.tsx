"use client";

import { api } from "@panara-cloud/backend/api";
import { useQuery } from "convex/react";
import { LogInIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useEmailEnabled } from "@/components/email/copy-link";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { AuthError, authClient, authResult } from "@/lib/auth/client";
import { authMessage } from "@/lib/auth/errors";
import {
	MAX_PASSWORD_LENGTH,
	MIN_PASSWORD_LENGTH,
	passwordProblem,
} from "@/lib/password";
import {
	AuthHeading,
	AuthTextLink,
	CopyCommand,
	FormError,
	TextField,
	TextLink,
	useNext,
	verifiedCallback,
} from "./ui";
import { CheckEmail } from "./verify-email";

// Sign-ups from an invitation link carry its id: holding the link proves the
// address, so the backend creates the account already verified.
const invitationIdFrom = (next: string) => {
	const url = new URL(next, "http://local");
	return url.pathname === "/invitation"
		? (url.searchParams.get("id") ?? undefined)
		: undefined;
};

export function SignupForm(props: {
	invitationId?: string;
	next?: string;
	eyebrow?: string;
	title?: string;
	description?: string;
	submitLabel?: string;
}) {
	const nav = useNext();
	const next = props.next ?? nav.next;
	const link = (path: string, extra: Record<string, string> = {}) => {
		const query = new URLSearchParams(extra);
		if (next !== "/") query.set("next", next);
		const search = query.toString();
		return search ? `${path}?${search}` : path;
	};
	const registrationOpen = useQuery(api.account.registrationOpen);
	const emailEnabled = useEmailEnabled();
	const invitationId = props.invitationId ?? invitationIdFrom(next);
	// The installer's one-time link (`install.sh setup-link`) for the first
	// account; the backend refuses the first sign-up without it.
	const setupToken = useSearchParams().get("setup") ?? undefined;
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [sentTo, setSentTo] = useState("");

	if (sentTo) {
		return (
			<CheckEmail email={sentTo} next={next} onBack={() => setSentTo("")} />
		);
	}

	if (registrationOpen && !setupToken && !invitationId) {
		return (
			<div className="flex flex-col gap-6">
				<AuthHeading
					title="Waiting for its first account"
					description="No one has signed up yet. The first account, the instance administrator, can only be created from the one-time setup link the installer printed."
				/>
				<div className="flex flex-col gap-2">
					<p className="font-medium text-sm">
						Lost the link? Print a new one on the server
					</p>
					<CopyCommand command="sudo sh install.sh setup-link" />
					<p className="text-muted-foreground text-xs">
						The link works once and expires after 7 days. Opening it brings you
						back here to create the account.
					</p>
				</div>
				<div className="flex flex-col gap-1 border-t pt-6">
					<p className="font-medium text-sm">Were you invited?</p>
					<p className="text-muted-foreground text-xs">
						Open the invitation link you were given. This page only creates the
						very first account.
					</p>
				</div>
				<p className="text-muted-foreground text-sm">
					Already have an account?{" "}
					<TextLink href={link("/login")}>Sign in</TextLink>
				</p>
			</div>
		);
	}

	const firstAccount = registrationOpen === true && !invitationId;

	return (
		<form
			className="flex flex-col gap-6"
			onSubmit={async (event) => {
				event.preventDefault();
				const data = new FormData(event.currentTarget);
				const email = String(data.get("email") ?? "")
					.trim()
					.toLowerCase();
				const password = String(data.get("password") ?? "");
				const problem = passwordProblem(password);
				if (problem) {
					setError(problem);
					return;
				}
				setPending(true);
				setError("");
				try {
					const result = await authResult(
						authClient.signUp.email({
							name: String(data.get("name") ?? "").trim(),
							email,
							password,
							callbackURL: verifiedCallback(next),
							...(invitationId ? { invitationId } : {}),
							...(registrationOpen && setupToken ? { setupToken } : {}),
						}),
					);
					if (!result.user.emailVerified) {
						setSentTo(email);
						return;
					}
					await authResult(
						authClient.signIn.email({ email, password, callbackURL: next }),
					);
					window.location.assign(next);
					return;
				} catch (error) {
					// The backend rejects uninvited sign-ups inside the user insert,
					// which Better Auth reports as a generic creation failure.
					if (
						error instanceof AuthError &&
						error.code === "FAILED_TO_CREATE_USER" &&
						registrationOpen !== true
					) {
						setError(
							"This email address doesn't have a pending invitation. Use the address your invitation was sent to, or ask an administrator to invite you.",
						);
					} else {
						setError(authMessage(error));
					}
				} finally {
					setPending(false);
				}
			}}
		>
			<div className="flex flex-col gap-3">
				{firstAccount && (
					<span className="inline-flex w-fit items-center gap-1.5 rounded-md bg-success/8 px-2 py-0.5 font-medium text-success text-xs">
						<span className="size-1.5 rounded-full bg-current" />
						Setup link · first account
					</span>
				)}
				{props.eyebrow && !firstAccount && (
					<p className="text-muted-foreground text-sm">{props.eyebrow}</p>
				)}
				<AuthHeading
					title={
						firstAccount
							? "Create the admin account"
							: (props.title ?? "Create your account")
					}
					description={
						props.description ??
						(registrationOpen === undefined
							? "Loading…"
							: firstAccount
								? "No one has signed up yet. This first account becomes the instance administrator and owns your first organization."
								: invitationId
									? "Sign up with the email address you were invited with."
									: emailEnabled === false
										? "This Panara Cloud instance is invitation-only. Open the invitation link you were given to create your account."
										: "This Panara Cloud instance is invitation-only. Sign up with the email address your invitation was sent to.")
					}
				/>
			</div>
			<FieldGroup>
				<TextField label="Name" name="name" autoComplete="name" required />
				<TextField
					label="Email"
					name="email"
					type="email"
					autoComplete="email"
					required
				/>
				<TextField
					label="Password"
					name="password"
					type="password"
					autoComplete="new-password"
					minLength={MIN_PASSWORD_LENGTH}
					maxLength={MAX_PASSWORD_LENGTH}
					required
					description={`At least ${MIN_PASSWORD_LENGTH} characters. You can add a passkey and 2FA after.`}
				/>
			</FieldGroup>
			<FormError>{error}</FormError>
			<Button type="submit" size="lg" disabled={pending}>
				{pending
					? "Creating account…"
					: (props.submitLabel ?? "Create account")}
			</Button>
			<nav
				aria-label="Account options"
				className="flex flex-wrap items-center justify-center gap-1 text-sm text-muted-foreground"
			>
				<span>
					{firstAccount ? "Already set up?" : "Already have an account?"}
				</span>
				<AuthTextLink href={link("/login")} icon={LogInIcon}>
					Sign in
				</AuthTextLink>
			</nav>
		</form>
	);
}
