"use client";

import { ArrowLeftIcon, CircleCheckIcon, ClockIcon } from "lucide-react";
import { useState } from "react";
import { useEmailEnabled } from "@/components/email/copy-link";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { AuthError, authClient, authResult } from "@/lib/auth/client";
import { authMessage } from "@/lib/auth/errors";
import { installerCommand } from "@/lib/installer";
import {
	MAX_PASSWORD_LENGTH,
	MIN_PASSWORD_LENGTH,
	passwordProblem,
} from "@/lib/password";
import { useRouter, useSearchParams } from "@/lib/router";
import Link from "@/lib/router/link";
import {
	AuthHeading,
	AuthStateIcon,
	BackToSignIn,
	CopyCommand,
	FormError,
	FormSuccess,
	PasswordStrength,
	TextField,
	TextLink,
	useNext,
} from "./ui";

export function ForgotPasswordForm() {
	const { link } = useNext();
	const emailEnabled = useEmailEnabled();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [sentTo, setSentTo] = useState("");
	if (emailEnabled === false) {
		return (
			<div className="flex flex-col gap-6">
				<AuthHeading
					title="Reset your password"
					description="This Panara Cloud doesn't send email, so it can't email you a reset link. An admin can make one for you instead."
				/>
				<ol className="flex flex-col border-y text-sm">
					{[
						"Ask an owner or admin of your organization.",
						<>
							They open{" "}
							<strong className="font-medium">Settings → Members</strong>, then{" "}
							<strong className="font-medium">Reset password link</strong> in
							the menu next to your name.
						</>,
						"Open the link they send you. It works once and expires in an hour.",
					].map((step, index) => (
						<li
							key={index}
							className="flex gap-4 border-b py-2.5 last:border-b-0"
						>
							<span className="w-3 shrink-0 font-mono text-muted-foreground text-xs leading-5">
								{index + 1}
							</span>
							<span>{step}</span>
						</li>
					))}
				</ol>
				<div className="flex flex-col gap-2">
					<p className="text-muted-foreground text-xs">
						You're the only admin? Run this on the server:
					</p>
					<CopyCommand command={installerCommand("reset-password <email>")} />
				</div>
				<Button
					variant="outline"
					size="lg"
					nativeButton={false}
					render={<Link href={link("/login")} />}
				>
					<ArrowLeftIcon />
					Back to sign in
				</Button>
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
						authClient.requestPasswordReset({
							email,
							redirectTo: "/reset-password",
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
			<AuthHeading
				title="Reset your password"
				description="Enter your account's email and we'll send you a link to choose a new password."
			/>
			<FieldGroup>
				<TextField
					label="Email"
					name="email"
					type="email"
					autoComplete="email"
					required
				/>
			</FieldGroup>
			<FormError>{error}</FormError>
			<Button type="submit" size="lg" disabled={pending}>
				{pending ? "Sending…" : "Send reset link"}
			</Button>
			{sentTo && (
				<FormSuccess>
					<div className="flex gap-2.5 rounded-lg border border-success/25 bg-success/8 p-3 text-success">
						<CircleCheckIcon className="mt-0.5 size-4 shrink-0" />
						<p>
							If an account exists for {sentTo}, a reset link is on its way. It
							expires in one hour.
						</p>
					</div>
				</FormSuccess>
			)}
			<p className="text-center text-muted-foreground text-sm">
				Remembered it?{" "}
				<TextLink href={link("/login")}>Back to sign in</TextLink>
			</p>
		</form>
	);
}

export function ResetPasswordForm() {
	const params = useSearchParams();
	const router = useRouter();
	const token = params.get("token") ?? "";
	const [pending, setPending] = useState(false);
	const broken = !token || !!params.get("error");
	const [error, setError] = useState(
		broken ? "This reset link is invalid or has expired." : "",
	);
	const [linkBroken, setLinkBroken] = useState(broken);
	const [password, setPassword] = useState("");

	if (linkBroken) {
		return (
			<div className="flex flex-col gap-6">
				<AuthStateIcon icon={ClockIcon} tone="warning" />
				<AuthHeading
					title="Reset link unavailable"
					description={
						<>{error} Reset links work once and expire after an hour.</>
					}
				/>
				<Button
					variant="outline"
					size="lg"
					nativeButton={false}
					render={<Link href="/forgot-password" />}
				>
					Request a new link
				</Button>
				<BackToSignIn href="/login" />
			</div>
		);
	}

	return (
		<form
			method="post"
			className="flex flex-col gap-6"
			onSubmit={async (event) => {
				event.preventDefault();
				const data = new FormData(event.currentTarget);
				const password = String(data.get("password") ?? "");
				const problem = passwordProblem(
					password,
					String(data.get("confirm") ?? ""),
				);
				if (problem) {
					setError(problem);
					return;
				}
				setPending(true);
				setError("");
				try {
					await authResult(
						authClient.resetPassword({ newPassword: password, token }),
					);
					router.push("/login?notice=reset");
				} catch (error) {
					setError(authMessage(error));
					if (
						error instanceof AuthError &&
						(error.code === "INVALID_TOKEN" || error.code === "TOKEN_EXPIRED")
					) {
						setLinkBroken(true);
					}
					setPending(false);
				}
			}}
		>
			<AuthHeading
				title="Choose a new password"
				description="Your other sessions will be signed out."
			/>
			<FieldGroup>
				<TextField
					label="New password"
					name="password"
					type="password"
					autoComplete="new-password"
					minLength={MIN_PASSWORD_LENGTH}
					maxLength={MAX_PASSWORD_LENGTH}
					required
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					description={<PasswordStrength password={password} />}
				/>
				<TextField
					label="Confirm new password"
					name="confirm"
					type="password"
					autoComplete="new-password"
					required
				/>
			</FieldGroup>
			<FormError>{error}</FormError>
			<Button type="submit" size="lg" disabled={pending}>
				{pending ? "Saving…" : "Change password"}
			</Button>
		</form>
	);
}
