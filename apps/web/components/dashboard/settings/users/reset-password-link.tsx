"use client";

import { api } from "@panara-cloud/backend/api";
import { useAction } from "convex/react";
import { useState } from "react";
import { CopyLinkField } from "@/components/email/copy-link";
import { FormError } from "@/components/settings/form-kit";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";

// A one-time link the administrator hands over: how members recover their
// password on an instance without email (and a shortcut on any instance).
export const ResetPasswordLink = ({
	userId,
	userEmail,
}: {
	userId: string;
	userEmail: string;
}) => {
	const { active } = useOrganization();
	const createLink = useAction(api.users.passwordResetLink);
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [url, setUrl] = useState<string | null>(null);

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) {
					setUrl(null);
					setError(null);
				}
			}}
		>
			<DialogTrigger
				role="menuitem"
				render={<DropdownMenuItem closeOnClick={false} />}
				nativeButton={false}
			>
				Reset password link
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Reset password link</DialogTitle>
					<DialogDescription>
						Create a one-time link for <strong>{userEmail}</strong> to choose a
						new password. Send it to them yourself; it signs them out everywhere
						once used.
					</DialogDescription>
				</DialogHeader>
				{error && (
					<FormError title="Couldn't create the link." message={error} />
				)}
				{url ? (
					<div className="flex flex-col gap-3">
						<CopyLinkField url={url} label="Reset link" />
						<p className="text-sm text-muted-foreground">
							Works once and expires in 24 hours. Anyone with the link can set
							the password, so share it privately.
						</p>
					</div>
				) : null}
				<DialogFooter>
					{url ? (
						<Button onClick={() => setOpen(false)}>Done</Button>
					) : (
						<Button
							disabled={pending}
							onClick={async () => {
								setPending(true);
								setError(null);
								try {
									const result = await createLink({
										organizationId: active.id,
										userId,
									});
									setUrl(result.url);
								} catch (error) {
									setError(errorMessage(error));
								} finally {
									setPending(false);
								}
							}}
						>
							{pending ? "Creating…" : "Create link"}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
