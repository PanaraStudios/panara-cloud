"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { AuthError, authClient, authResult } from "@/lib/auth/client";
import { authMessage } from "@/lib/auth/errors";
import {
	AuthHeading,
	FormError,
	OtpBoxes,
	TextField,
	TextLink,
	useNext,
} from "./ui";

// The pending two-factor sign-in lives in a short-lived cookie; when it is
// gone, the only way forward is signing in with the password again.
const RESTART = new Set([
	"INVALID_TWO_FACTOR_COOKIE",
	"TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE",
	"UNAUTHORIZED",
]);

export function MfaForm() {
	const { next, link } = useNext();
	const trustId = useId();
	const [backup, setBackup] = useState(false);
	const [trust, setTrust] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [restart, setRestart] = useState(false);
	const [totp, setTotp] = useState("");
	const codeId = useId();

	return (
		<form
			method="post"
			className="flex flex-col gap-6"
			onSubmit={async (event) => {
				event.preventDefault();
				const code = (
					backup ? String(new FormData(event.currentTarget).get("code")) : totp
				)
					.trim()
					.replace(/\s+/g, "");
				setPending(true);
				setError("");
				try {
					await authResult(
						backup
							? authClient.twoFactor.verifyBackupCode({
									code,
									trustDevice: trust,
								})
							: authClient.twoFactor.verifyTotp({ code, trustDevice: trust }),
					);
					window.location.assign(next);
				} catch (error) {
					setError(authMessage(error));
					setRestart(
						error instanceof AuthError && RESTART.has(error.code ?? ""),
					);
					setPending(false);
				}
			}}
		>
			<AuthHeading
				title="Two-factor authentication"
				description={
					backup
						? "Enter one of the backup codes you saved when you turned on two-factor authentication. Each code works once."
						: "Enter the 6-digit code from your authenticator app."
				}
			/>
			<FieldGroup>
				{backup ? (
					<TextField
						label="Backup code"
						name="code"
						autoComplete="one-time-code"
						maxLength={32}
						autoFocus
						required
					/>
				) : (
					<Field>
						<FieldLabel htmlFor={codeId}>Authentication code</FieldLabel>
						<OtpBoxes id={codeId} value={totp} onChange={setTotp} autoFocus />
					</Field>
				)}
				<Field orientation="horizontal">
					<Checkbox
						id={trustId}
						checked={trust}
						onCheckedChange={(checked) => setTrust(checked === true)}
					/>
					<FieldLabel htmlFor={trustId} className="font-normal">
						Trust this device for 30 days
					</FieldLabel>
				</Field>
			</FieldGroup>
			<FormError>{error}</FormError>
			<Button
				type="submit"
				size="lg"
				disabled={pending || (!backup && totp.length < 6) || restart}
			>
				{pending ? "Verifying…" : "Verify"}
			</Button>
			<div className="flex items-center justify-between gap-3 text-sm">
				<button
					type="button"
					className="font-medium underline-offset-4 hover:underline"
					onClick={() => {
						setBackup(!backup);
						setError("");
					}}
				>
					{backup ? "Use your authenticator app" : "Use a backup code"}
				</button>
				<TextLink
					href={link("/login")}
					className="font-normal text-muted-foreground hover:text-foreground"
				>
					Sign in again
				</TextLink>
			</div>
			{backup && (
				<p className="text-muted-foreground text-xs">
					Lost your authenticator and your backup codes? Ask your instance
					administrator to reset two-factor authentication for your account.
				</p>
			)}
		</form>
	);
}
