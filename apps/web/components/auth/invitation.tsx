"use client";

import { useConvexAuth } from "convex/react";
import { ArrowRightIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { SignOutButton } from "@/components/sign-out-button";
import { Button, buttonVariants } from "@/components/ui/button";
import { authClient, authResult } from "@/lib/auth/client";
import { authMessage } from "@/lib/auth/errors";
import { withNext } from "@/lib/next-path";
import { SignupForm } from "./signup-form";
import { AuthHeading, FormError, FormSuccess } from "./ui";

type InvitationDetails = {
	id: string;
	email: string;
	role: string;
	status: string;
	expiresAt: Date | string;
	organizationName: string;
	inviterEmail: string;
};

const roleLabels: Record<string, string> = {
	owner: "Owner",
	admin: "Admin",
	member: "Member",
};

export function Invitation() {
	const params = useSearchParams();
	const id = params.get("id") ?? "";
	const here = `/invitation?id=${encodeURIComponent(id)}`;
	const { isAuthenticated, isLoading } = useConvexAuth();
	const session = authClient.useSession();
	const [invitation, setInvitation] = useState<InvitationDetails | null>(null);
	const [loadError, setLoadError] = useState("");
	const [error, setError] = useState("");
	const [pending, setPending] = useState<"accept" | "decline" | null>(null);
	const [outcome, setOutcome] = useState<"accepted" | "declined" | null>(null);

	useEffect(() => {
		if (!isAuthenticated || !id) return;
		let active = true;
		authResult(authClient.organization.getInvitation({ query: { id } }))
			.then((data) => {
				if (active) setInvitation(data as InvitationDetails);
			})
			.catch((error) => {
				if (active) setLoadError(authMessage(error));
			});
		return () => {
			active = false;
		};
	}, [isAuthenticated, id]);

	if (!id) {
		return (
			<div className="flex flex-col gap-6">
				<AuthHeading
					title="Invitation link incomplete"
					description="Open the link from your invitation email again, or ask the person who invited you to resend it."
				/>
				<Button
					variant="outline"
					size="lg"
					nativeButton={false}
					render={<Link href="/login" />}
				>
					Back to sign in
				</Button>
			</div>
		);
	}

	if (isLoading || (isAuthenticated && !invitation && !loadError)) {
		return <p role="status">Loading invitation…</p>;
	}

	if (!isAuthenticated) {
		return (
			<div className="flex flex-col gap-6">
				<SignupForm
					invitationId={id}
					next={here}
					eyebrow="You've been invited to"
					title="Join Panara Cloud"
					description="Create your account with the email address the invitation was sent to."
					submitLabel="Create account and join"
				/>
				<p className="text-center text-muted-foreground text-xs">
					Holding this link proves the address, so no verification email is
					needed.
				</p>
			</div>
		);
	}

	const signedInAs = session.data?.user.email;

	if (!invitation) {
		return (
			<div className="flex flex-col gap-6">
				<AuthHeading title="Invitation unavailable" />
				<FormError>{loadError}</FormError>
				<p className="text-sm text-muted-foreground">
					You&apos;re signed in as <strong>{signedInAs}</strong>. If the
					invitation was sent to another address, sign out and sign in with that
					one.
				</p>
				<div className="flex flex-wrap gap-2">
					<Link href="/" className={buttonVariants({ variant: "outline" })}>
						Go to Panara Cloud
					</Link>
					<SignOutButton
						variant="ghost"
						size="default"
						redirectTo={withNext("/login", here)}
					>
						Use another account
					</SignOutButton>
				</div>
			</div>
		);
	}

	if (outcome) {
		return (
			<div className="flex flex-col gap-6">
				<AuthHeading
					title={
						outcome === "accepted"
							? `You joined ${invitation.organizationName}`
							: "Invitation declined"
					}
				/>
				<FormSuccess>
					{outcome === "accepted"
						? `You're now a ${roleLabels[invitation.role]?.toLowerCase() ?? invitation.role} of ${invitation.organizationName}.`
						: `You won't join ${invitation.organizationName}.`}
				</FormSuccess>
				<Link href="/" className={buttonVariants()}>
					Continue to Panara Cloud
					<ArrowRightIcon data-icon="inline-end" />
				</Link>
			</div>
		);
	}

	const expired = new Date(invitation.expiresAt).getTime() < Date.now();
	const open = invitation.status === "pending" && !expired;

	async function respond(accept: boolean) {
		setPending(accept ? "accept" : "decline");
		setError("");
		try {
			if (accept) {
				await authResult(
					authClient.organization.acceptInvitation({ invitationId: id }),
				);
			} else {
				await authResult(
					authClient.organization.rejectInvitation({ invitationId: id }),
				);
			}
			setOutcome(accept ? "accepted" : "declined");
		} catch (error) {
			setError(authMessage(error));
		} finally {
			setPending(null);
		}
	}

	const signedInName = session.data?.user.name;
	const wrongAccount =
		!!signedInAs && signedInAs.toLowerCase() !== invitation.email.toLowerCase();
	const expires = new Date(invitation.expiresAt);
	const days = Math.max(
		0,
		Math.ceil((expires.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
	);

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-2">
				<p className="text-muted-foreground text-sm">
					{invitation.inviterEmail} invited you to
				</p>
				<h1 className="font-semibold text-2xl">
					Join {invitation.organizationName}
				</h1>
			</div>
			<dl className="grid grid-cols-[7.5rem_1fr] border-t text-sm">
				{[
					[
						"Invited email",
						<span key="email" className="break-all font-mono text-[13px]">
							{invitation.email}
						</span>,
					],
					["Role", roleLabels[invitation.role] ?? invitation.role],
					[
						"Expires",
						expired
							? "Expired"
							: `${expires.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, in ${days} ${days === 1 ? "day" : "days"}`,
					],
				].map(([label, value]) => (
					<div
						key={String(label)}
						className="col-span-2 grid grid-cols-subgrid border-b py-2.5"
					>
						<dt className="text-muted-foreground">{label}</dt>
						<dd>{value}</dd>
					</div>
				))}
			</dl>
			{!open && (
				<FormError>
					{expired
						? "This invitation has expired. Ask for a new one."
						: `This invitation was already ${invitation.status}.`}
				</FormError>
			)}
			<FormError>{error}</FormError>
			{open && (
				<div className="flex gap-2">
					<Button
						variant="outline"
						size="lg"
						disabled={pending !== null}
						onClick={() => respond(false)}
					>
						{pending === "decline" ? "Declining…" : "Decline"}
					</Button>
					<Button
						size="lg"
						className="flex-1"
						disabled={pending !== null || wrongAccount}
						onClick={() => respond(true)}
					>
						{pending === "accept" ? "Accepting…" : "Accept invitation"}
					</Button>
				</div>
			)}
			<div className="flex items-center gap-3 border-t pt-5 text-sm">
				<span className="flex size-7 shrink-0 items-center justify-center rounded-full border font-medium text-[10px] text-muted-foreground">
					{initials(signedInName ?? signedInAs ?? "")}
				</span>
				<span className="min-w-0 flex-1 truncate text-muted-foreground">
					Signed in as {signedInName ?? signedInAs}
				</span>
				<SignOutButton
					variant="ghost"
					size="sm"
					redirectTo={withNext("/login", here)}
				>
					Not you? Sign out
				</SignOutButton>
			</div>
			{wrongAccount && (
				<div className="rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm text-warning">
					<p className="font-medium">Signed in with another email</p>
					<p>
						This invitation is for {invitation.email}. Sign out and sign in with
						that address to accept.
					</p>
				</div>
			)}
		</div>
	);
}

function initials(value: string) {
	return (
		value
			.split(/[\s@.]+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase())
			.join("") || "?"
	);
}
