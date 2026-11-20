"use client";

import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { TextField } from "@/components/auth/ui";
import { StatusDot } from "@/components/settings/form-kit";
import { Button } from "@/components/ui/button";
import { authClient, authResult } from "@/lib/auth/client";
import { ActionDialog, ActionFeedback, useAction } from "./shared";

function BackupCodes({ codes }: { codes: string[] }) {
	const [copied, setCopied] = useState(false);
	const text = codes.join("\n");
	return (
		<div className="flex flex-col gap-3">
			<ul
				aria-label="Backup codes"
				className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border bg-muted/50 p-3 font-mono text-sm"
			>
				{codes.map((code) => (
					<li key={code}>{code}</li>
				))}
			</ul>
			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={async () => {
						await navigator.clipboard.writeText(text);
						setCopied(true);
					}}
				>
					{copied ? (
						<CheckIcon data-icon="inline-start" />
					) : (
						<CopyIcon data-icon="inline-start" />
					)}
					{copied ? "Copied" : "Copy codes"}
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => {
						const url = URL.createObjectURL(
							new Blob([`Panara Cloud backup codes\n\n${text}\n`], {
								type: "text/plain",
							}),
						);
						const anchor = document.createElement("a");
						anchor.href = url;
						anchor.download = "panara-cloud-backup-codes.txt";
						anchor.click();
						URL.revokeObjectURL(url);
					}}
				>
					<DownloadIcon data-icon="inline-start" />
					Download
				</Button>
			</div>
			<p className="text-sm text-muted-foreground">
				Store these somewhere safe, like a password manager. Each code signs you
				in once if you lose your authenticator. You won&apos;t see them again.
			</p>
		</div>
	);
}

type Enrollment = { totpURI: string; backupCodes: string[] };

function EnableDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
	const [verified, setVerified] = useState(false);
	const { pending, error, run, reset } = useAction();
	const secret = enrollment
		? (new URL(enrollment.totpURI).searchParams.get("secret") ?? "")
		: "";

	function close(next: boolean) {
		onOpenChange(next);
		if (!next) {
			setEnrollment(null);
			setVerified(false);
			reset();
		}
	}

	if (verified && enrollment) {
		return (
			<ActionDialog
				open={open}
				onOpenChange={close}
				title="Save your backup codes"
				description="Two-factor is on. If you lose your phone, each code signs you in once. They won't be shown again."
				pending={false}
				error={null}
				footer={
					<Button type="button" onClick={() => close(false)}>
						I&apos;ve saved my codes
					</Button>
				}
			>
				<BackupCodes codes={enrollment.backupCodes} />
			</ActionDialog>
		);
	}

	if (enrollment) {
		return (
			<ActionDialog
				open={open}
				onOpenChange={close}
				title="Scan with your authenticator"
				description="1Password, Google Authenticator, Authy or any TOTP app."
				submitLabel="Verify and turn on"
				pending={pending}
				error={error}
				onSubmit={(data) =>
					run(async () => {
						const code = String(data.get("code")).replace(/\s+/g, "");
						await authResult(authClient.twoFactor.verifyTotp({ code }));
						setVerified(true);
						return undefined;
					})
				}
			>
				<div className="flex items-center gap-5">
					<div className="shrink-0 rounded-xl border bg-white p-3">
						<QRCodeSVG
							value={enrollment.totpURI}
							size={136}
							title="QR code for your authenticator app"
						/>
					</div>
					<div className="flex min-w-0 flex-col gap-1.5 text-sm">
						<span className="text-muted-foreground">
							Can&apos;t scan? Enter this key
						</span>
						<code
							data-testid="totp-secret"
							className="break-all font-mono text-[13px] leading-6"
						>
							{secret.match(/.{1,4}/g)?.join(" ")}
						</code>
						<button
							type="button"
							className="w-fit font-medium underline-offset-4 hover:underline"
							onClick={() => void navigator.clipboard.writeText(secret)}
						>
							Copy key
						</button>
					</div>
				</div>
				<TextField
					label="6-digit code from the app"
					name="code"
					autoComplete="one-time-code"
					inputMode="numeric"
					maxLength={7}
					className="[&_input]:h-11 [&_input]:font-mono [&_input]:text-lg [&_input]:tracking-[0.3em]"
					required
				/>
			</ActionDialog>
		);
	}

	return (
		<ActionDialog
			open={open}
			onOpenChange={close}
			title="Turn on two-factor authentication"
			description="Confirm your password to set up an authenticator app."
			submitLabel="Continue"
			pending={pending}
			error={error}
			onSubmit={(data) =>
				run(async () => {
					const result = await authResult(
						authClient.twoFactor.enable({
							password: String(data.get("password")),
						}),
					);
					setEnrollment(result as Enrollment);
					return undefined;
				})
			}
		>
			<TextField
				label="Password"
				name="password"
				type="password"
				autoComplete="current-password"
				required
				autoFocus
			/>
		</ActionDialog>
	);
}

function RegenerateDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [codes, setCodes] = useState<string[]>([]);
	const { pending, error, run, reset } = useAction();
	function close(next: boolean) {
		onOpenChange(next);
		if (!next) {
			setCodes([]);
			reset();
		}
	}
	return (
		<ActionDialog
			open={open}
			onOpenChange={close}
			title={codes.length ? "Your new backup codes" : "Regenerate backup codes"}
			description={
				codes.length
					? "Your previous backup codes no longer work."
					: "Confirm your password. Your current backup codes stop working."
			}
			submitLabel="Regenerate codes"
			pending={pending}
			error={error}
			footer={
				codes.length ? (
					<Button type="button" onClick={() => close(false)}>
						I&apos;ve saved my codes
					</Button>
				) : undefined
			}
			onSubmit={(data) =>
				run(async () => {
					const result = await authResult(
						authClient.twoFactor.generateBackupCodes({
							password: String(data.get("password")),
						}),
					);
					setCodes(result.backupCodes);
					return undefined;
				})
			}
		>
			{codes.length ? (
				<BackupCodes codes={codes} />
			) : (
				<TextField
					label="Password"
					name="password"
					type="password"
					autoComplete="current-password"
					required
					autoFocus
				/>
			)}
		</ActionDialog>
	);
}

function DisableDialog({
	open,
	onOpenChange,
	onDisabled,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onDisabled: () => void;
}) {
	const { pending, error, run, reset } = useAction();
	return (
		<ActionDialog
			open={open}
			onOpenChange={(next) => {
				onOpenChange(next);
				if (!next) reset();
			}}
			title="Turn off two-factor authentication?"
			description="Signing in will only need your password or a passkey. Your backup codes stop working."
			submitLabel="Turn off"
			destructive
			pending={pending}
			error={error}
			onSubmit={(data) =>
				run(async () => {
					await authResult(
						authClient.twoFactor.disable({
							password: String(data.get("password")),
						}),
					);
					onOpenChange(false);
					onDisabled();
					return undefined;
				})
			}
		>
			<TextField
				label="Password"
				name="password"
				type="password"
				autoComplete="current-password"
				required
				autoFocus
			/>
		</ActionDialog>
	);
}

export function TwoFactorCard({ enabled }: { enabled: boolean }) {
	const [dialog, setDialog] = useState<
		"enable" | "regenerate" | "disable" | null
	>(null);
	const [notice, setNotice] = useState("");
	const toggle = (name: typeof dialog) => (open: boolean) =>
		setDialog(open ? name : null);
	return (
		<>
			<section className="flex flex-col gap-4 border-border border-t pt-8">
				<div className="flex items-start justify-between gap-4">
					<div className="min-w-0 space-y-1">
						<h2 className="flex items-center gap-3 font-semibold text-[15px]">
							Two-factor authentication
							<StatusDot
								tone={enabled ? "success" : "secondary"}
								className="font-normal text-muted-foreground text-sm"
							>
								{enabled ? "On" : "Off"}
							</StatusDot>
						</h2>
						<p className="text-muted-foreground text-sm">
							Ask for a code from an authenticator app after your password.
						</p>
					</div>
					{enabled ? (
						<div className="flex shrink-0 flex-wrap justify-end gap-2">
							<Button
								variant="outline"
								size="sm"
								onClick={() => setDialog("regenerate")}
							>
								Regenerate backup codes
							</Button>
							<Button
								variant="outline"
								size="sm"
								onClick={() => setDialog("disable")}
							>
								Turn off
							</Button>
						</div>
					) : (
						<Button
							variant="outline"
							size="sm"
							className="shrink-0"
							onClick={() => {
								setNotice("");
								setDialog("enable");
							}}
						>
							Turn on
						</Button>
					)}
				</div>
				{notice ? <ActionFeedback error={null} success={notice} /> : null}
			</section>
			<EnableDialog
				open={dialog === "enable"}
				onOpenChange={toggle("enable")}
			/>
			<RegenerateDialog
				open={dialog === "regenerate"}
				onOpenChange={toggle("regenerate")}
			/>
			<DisableDialog
				open={dialog === "disable"}
				onOpenChange={toggle("disable")}
				onDisabled={() => setNotice("Two-factor authentication is off.")}
			/>
		</>
	);
}
