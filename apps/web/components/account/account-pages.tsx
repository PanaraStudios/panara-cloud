"use client";

import { api } from "@panara-cloud/backend/api";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useId, useRef, useState } from "react";
import { TextField } from "@/components/auth/ui";
import { ProfileForm } from "@/components/dashboard/settings/profile/profile-form";
import { useEmailEnabled } from "@/components/email/copy-link";
import { FieldGrid, StatusDot } from "@/components/settings/form-kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { authClient, authResult } from "@/lib/auth/client";
import {
	MAX_PASSWORD_LENGTH,
	MIN_PASSWORD_LENGTH,
	passwordProblem,
} from "@/lib/password";
import { useRouter } from "@/lib/router";
import { PasskeysCard } from "./passkeys-card";
import { ActionDialog, ActionFeedback, useAction } from "./shared";
import { TwoFactorCard } from "./two-factor-card";

type Security = NonNullable<FunctionReturnType<typeof api.account.security>>;

function ProfileCard({ security }: { security: Security }) {
	const router = useRouter();
	const { pending, error, success, run } = useAction();
	const nameId = useId();
	const [dirty, setDirty] = useState(false);
	return (
		<form
			method="post"
			className="flex flex-col gap-4 border-border border-t pt-8"
			onSubmit={(event) => {
				event.preventDefault();
				const name = String(
					new FormData(event.currentTarget).get("name"),
				).trim();
				run(async () => {
					await authResult(authClient.updateUser({ name }));
					setDirty(false);
					router.refresh();
					return "Your name was updated.";
				});
			}}
		>
			<div className="space-y-1">
				<h2 id={`${nameId}-label`} className="font-semibold text-[15px]">
					Name
				</h2>
				<p className="text-muted-foreground text-sm">
					Shown on your activity, deployments and invitations.
				</p>
			</div>
			<FieldGrid>
				<Input
					id={nameId}
					aria-labelledby={`${nameId}-label`}
					name="name"
					autoComplete="name"
					defaultValue={security.name}
					required
					onChange={(event) =>
						setDirty(event.target.value.trim() !== security.name)
					}
				/>
			</FieldGrid>
			<ActionFeedback error={error} success={success} />
			<div className="flex justify-end">
				<Button type="submit" size="sm" disabled={pending || !dirty}>
					{pending ? "Saving…" : "Save"}
				</Button>
			</div>
		</form>
	);
}

function EmailCard({ security }: { security: Security }) {
	const { pending, error, success, run, reset } = useAction();
	const [open, setOpen] = useState(false);
	const emailEnabled = useEmailEnabled();
	const changeDirectly = useMutation(
		api.account.changeEmailWithoutConfirmation,
	);
	return (
		<section className="flex flex-col gap-4 border-border border-t pt-8">
			<div className="space-y-1">
				<h2 className="font-semibold text-[15px]">Email</h2>
				<p className="text-muted-foreground text-sm">
					Used to sign in.
					{emailEnabled === false
						? " This instance doesn't send email, so a change applies immediately."
						: " A change is confirmed from your current address first."}
				</p>
			</div>
			<div className="flex min-h-14 items-center gap-4 border-border border-y py-2.5">
				<div className="flex min-w-0 flex-1 flex-col text-sm">
					<span className="truncate font-medium">{security.email}</span>
					<StatusDot
						tone={security.emailVerified ? "success" : "warning"}
						className="text-muted-foreground"
					>
						{security.emailVerified ? "Verified" : "Unverified"}
					</StatusDot>
				</div>
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						reset();
						setOpen(true);
					}}
				>
					Change email
				</Button>
			</div>
			<ActionFeedback error={null} success={open ? null : success} />
			<ActionDialog
				open={open}
				onOpenChange={setOpen}
				title="Change email"
				description={
					emailEnabled === false
						? "The change applies immediately. It needs a sign-in from the last 5 minutes."
						: "We confirm the change with your current address first."
				}
				submitLabel={
					emailEnabled === false ? "Change email" : "Send confirmation"
				}
				pending={pending}
				error={error}
				onSubmit={(data) =>
					run(async () => {
						const newEmail = String(data.get("email")).trim().toLowerCase();
						if (newEmail === security.email) {
							throw new Error("That's already your email address.");
						}
						if (emailEnabled === false) {
							await changeDirectly({ newEmail });
							setOpen(false);
							return (
								<p>
									You now sign in with <strong>{newEmail}</strong>.
								</p>
							);
						}
						await authResult(
							authClient.changeEmail({
								newEmail,
								callbackURL: "/account/profile",
							}),
						);
						setOpen(false);
						return (
							<p>
								We sent a confirmation link to <strong>{security.email}</strong>
								. After you confirm it, we&apos;ll send a verification link to{" "}
								<strong>{newEmail}</strong>.
							</p>
						);
					})
				}
			>
				<TextField
					label="New email address"
					name="email"
					type="email"
					autoComplete="email"
					required
				/>
			</ActionDialog>
		</section>
	);
}

function PasswordCard() {
	const revokeId = useId();
	const [revokeOthers, setRevokeOthers] = useState(true);
	const { pending, error, success, run } = useAction();
	return (
		<form
			method="post"
			onSubmit={(event) => {
				event.preventDefault();
				const form = event.currentTarget;
				const data = new FormData(form);
				const newPassword = String(data.get("newPassword") ?? "");
				run(async () => {
					const problem = passwordProblem(
						newPassword,
						String(data.get("confirmPassword") ?? ""),
					);
					if (problem) throw new Error(problem);
					await authResult(
						authClient.changePassword({
							currentPassword: String(data.get("currentPassword") ?? ""),
							newPassword,
							revokeOtherSessions: revokeOthers,
						}),
					);
					form.reset();
					return revokeOthers
						? "Password changed. Your other sessions were signed out."
						: "Password changed.";
				});
			}}
		>
			<section className="flex flex-col gap-4 border-border border-t pt-8">
				<div className="space-y-1">
					<h2 className="font-semibold text-[15px]">Password</h2>
					<p className="text-muted-foreground text-sm">
						At least {MIN_PASSWORD_LENGTH} characters. A long passphrase is
						easier to remember and harder to guess.
					</p>
				</div>
				<div className="grid gap-4 sm:grid-cols-3">
					<TextField
						label="Current"
						name="currentPassword"
						type="password"
						autoComplete="current-password"
						required
					/>
					<TextField
						label="New"
						name="newPassword"
						type="password"
						autoComplete="new-password"
						placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
						minLength={MIN_PASSWORD_LENGTH}
						maxLength={MAX_PASSWORD_LENGTH}
						required
					/>
					<TextField
						label="Confirm"
						name="confirmPassword"
						type="password"
						autoComplete="new-password"
						required
					/>
				</div>
				<div className="flex items-center justify-between gap-3">
					<Field orientation="horizontal" className="w-auto">
						<Checkbox
							id={revokeId}
							checked={revokeOthers}
							onCheckedChange={(checked) => setRevokeOthers(checked === true)}
						/>
						<FieldLabel htmlFor={revokeId} className="font-normal">
							Sign out of all other sessions
						</FieldLabel>
					</Field>
					<Button type="submit" size="sm" disabled={pending}>
						{pending ? "Saving…" : "Change password"}
					</Button>
				</div>
				<ActionFeedback error={error} success={success} />
			</section>
		</form>
	);
}

function useSecurity() {
	const { isLoading } = useConvexAuth();
	const live = useQuery(api.account.security, isLoading ? "skip" : {});
	// Password changes, 2FA and passkey sign-ins rotate the session; the query
	// briefly resolves signed-out while the new token loads. Keep showing the
	// last value so open dialogs and form messages survive the rotation.
	const last = useRef<Security | null>(null);
	if (live) last.current = live;
	return live ?? last.current;
}

function Loading() {
	return (
		<div className="flex flex-col gap-6" aria-busy="true">
			<Skeleton className="h-8 w-48" />
			<Skeleton className="h-40 w-full" />
		</div>
	);
}

// The tab names the page, so its heading is for screen readers only and the
// first section starts without a rule under the tabs.
const PAGE =
	"flex w-full flex-col gap-8 pb-10 [&>h2+*]:border-t-0 [&>h2+*]:pt-0 [&>h2+*>section]:border-t-0 [&>h2+*>section]:pt-0";

export function ProfilePage() {
	const security = useSecurity();
	if (!security) return <Loading />;
	return (
		<div className={PAGE}>
			<h2 className="sr-only">Profile</h2>
			<ProfileForm />
			<ProfileCard security={security} />
			<EmailCard security={security} />
		</div>
	);
}

export function SecurityPage() {
	const security = useSecurity();
	if (!security) return <Loading />;
	return (
		<div className={PAGE}>
			<h2 className="sr-only">Security</h2>
			<TwoFactorCard enabled={security.twoFactorEnabled} />
			<PasskeysCard />
			<PasswordCard />
		</div>
	);
}
