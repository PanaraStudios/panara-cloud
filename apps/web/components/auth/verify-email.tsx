"use client";

import { CheckIcon, ClockIcon, MailIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useEmailEnabled } from "@/components/email/copy-link";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { authClient, authResult } from "@/lib/auth/client";
import { authMessage } from "@/lib/auth/errors";
import { useSearchParams } from "@/lib/router";
import {
	AuthHeading,
	AuthStateIcon,
	BackToSignIn,
	FormError,
	FormSuccess,
	TextField,
	useNext,
	verifiedCallback,
} from "./ui";

const linkErrors: Record<string, { title: string; description: string }> = {
	TOKEN_EXPIRED: {
		title: "This link has expired",
		description:
			"Email links are valid for a limited time. We'll send a fresh one.",
	},
	INVALID_TOKEN: {
		title: "This link isn't valid",
		description:
			"It may have been used already or copied incompletely. Request a new verification email below.",
	},
	USER_NOT_FOUND: {
		title: "Account not found",
		description: "The account this link was sent for no longer exists.",
	},
	INVALID_USER: {
		title: "Signed in as someone else",
		description:
			"This link belongs to a different account than the one you're signed in with. Sign out and open it again.",
	},
};

export function VerifyEmail() {
	const params = useSearchParams();
	const { next, link } = useNext();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [sentTo, setSentTo] = useState("");
	const linkError = linkErrors[params.get("error") ?? ""] ?? null;
	const emailEnabled = useEmailEnabled();

	if (params.get("verified") && !params.get("error")) {
		return <EmailVerified next={next} />;
	}

	if (emailEnabled === false) {
		return (
			<div className="flex flex-col gap-6">
				<AuthHeading
					title={linkError?.title ?? "Verify your email"}
					description="This Panara Cloud instance doesn't send email, so it can't send verification links."
				/>
				<p className="text-sm">
					Accounts created from an invitation link don&apos;t need one. If your
					account is still unverified, ask an administrator for a password reset
					link (Settings → Members): using it verifies your address too.
				</p>
				<BackToSignIn href={link("/login")} />
			</div>
		);
	}

	return (
		<form
			method="post"
			className="flex flex-col gap-6"
			onSubmit={async (event) => {
				event.preventDefault();
				const email = String(new FormData(event.currentTarget).get("email"))
					.trim()
					.toLowerCase();
				setPending(true);
				setError("");
				setSentTo("");
				try {
					await authResult(
						authClient.sendVerificationEmail({
							email,
							callbackURL: verifiedCallback(next),
						}),
					);
					setSentTo(email);
				} catch (error) {
					setError(authMessage(error));
				} finally {
					setPending(false);
				}
			}}
		>
			{linkError && <AuthStateIcon icon={ClockIcon} tone="warning" />}
			<AuthHeading
				title={linkError?.title ?? "Verify your email"}
				description={
					linkError?.description ??
					"Enter the email address you signed up with and we'll send a new verification link."
				}
			/>
			<FieldGroup>
				<TextField
					label="Email"
					name="email"
					type="email"
					autoComplete="email"
					defaultValue={params.get("email") ?? ""}
					required
				/>
			</FieldGroup>
			<FormError>{error}</FormError>
			{sentTo && (
				<FormSuccess>
					<p>
						If <strong>{sentTo}</strong> belongs to an unverified account, a new
						verification link is on its way.
					</p>
				</FormSuccess>
			)}
			<Button type="submit" size="lg" disabled={pending}>
				{pending ? "Sending…" : "Send verification email"}
			</Button>
			<BackToSignIn href={link("/login")} />
		</form>
	);
}

const RESEND_AFTER_S = 60;

/** After sign-up: the verification link is on its way (A-07). */
export function CheckEmail({
	email,
	next,
	onBack,
}: {
	email: string;
	next: string;
	onBack: () => void;
}) {
	const [wait, setWait] = useState(RESEND_AFTER_S);
	const [error, setError] = useState("");
	useEffect(() => {
		if (wait <= 0) return;
		const timer = setTimeout(() => setWait((value) => value - 1), 1000);
		return () => clearTimeout(timer);
	}, [wait]);
	return (
		<div className="flex flex-col gap-6">
			<AuthStateIcon icon={MailIcon} />
			<AuthHeading
				title="Check your email"
				description={
					<>
						We sent a verification link to{" "}
						<span className="font-medium text-foreground">{email}</span>. Open
						it to finish creating your account; it signs you in automatically.
					</>
				}
			/>
			<FormError>{error}</FormError>
			<Button
				type="button"
				variant="outline"
				size="lg"
				disabled={wait > 0}
				onClick={async () => {
					setError("");
					try {
						await authResult(
							authClient.sendVerificationEmail({
								email,
								callbackURL: verifiedCallback(next),
							}),
						);
						setWait(RESEND_AFTER_S);
					} catch (error) {
						setError(authMessage(error));
					}
				}}
			>
				{wait > 0
					? `Resend link in 0:${String(wait).padStart(2, "0")}`
					: "Resend link"}
			</Button>
			<p className="text-muted-foreground text-xs">
				Didn&apos;t get it? Check spam, or{" "}
				<button
					type="button"
					onClick={onBack}
					className="font-medium text-foreground underline-offset-4 hover:underline"
				>
					use a different email
				</button>
				.
			</p>
		</div>
	);
}

/** Landing page of a verification link (A-09): confirmed, then onwards. */
function EmailVerified({ next }: { next: string }) {
	const session = authClient.useSession();
	const email = session.data?.user.email;
	const [progress, setProgress] = useState(0);
	useEffect(() => {
		const started = Date.now();
		const timer = setInterval(() => {
			const value = Math.min(1, (Date.now() - started) / 2500);
			setProgress(value);
			if (value >= 1) {
				clearInterval(timer);
				window.location.assign(next);
			}
		}, 50);
		return () => clearInterval(timer);
	}, [next]);
	return (
		<div className="flex flex-col gap-6">
			<AuthStateIcon icon={CheckIcon} tone="success" />
			<AuthHeading
				title="Email verified"
				description={`${email ?? "Your address"} is confirmed. Taking you to Panara Cloud…`}
			/>
			<div className="h-0.5 overflow-hidden rounded-full bg-border">
				<div
					className="h-full bg-foreground transition-[width] duration-75"
					style={{ width: `${progress * 100}%` }}
				/>
			</div>
			<Button size="lg" onClick={() => window.location.assign(next)}>
				Continue
			</Button>
		</div>
	);
}
