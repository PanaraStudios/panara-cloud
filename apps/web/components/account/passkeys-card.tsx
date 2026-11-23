"use client";

import { useCallback, useEffect, useState } from "react";
import { TextField } from "@/components/auth/ui";
import { Button } from "@/components/ui/button";
import { AuthError, authClient, authResult } from "@/lib/auth/client";
import { ActionDialog, ActionFeedback, formatDate, useAction } from "./shared";

type Passkey = {
	id: string;
	name?: string | null;
	createdAt: Date | string;
	deviceType: string;
	backedUp: boolean;
};

function defaultPasskeyName() {
	const ua = navigator.userAgent;
	const os = /Mac OS X/.test(ua)
		? "Mac"
		: /iPhone|iPad/.test(ua)
			? "iPhone"
			: /Android/.test(ua)
				? "Android"
				: /Windows/.test(ua)
					? "Windows"
					: "This device";
	return `Passkey on ${os}`;
}

export function PasskeysCard() {
	const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
	const [dialog, setDialog] = useState<
		| { kind: "add" }
		| { kind: "rename"; passkey: Passkey }
		| { kind: "delete"; passkey: Passkey }
		| null
	>(null);
	const list = useAction();
	const action = useAction();

	const load = useCallback(async () => {
		const data = await authResult(authClient.passkey.listUserPasskeys());
		setPasskeys(data as Passkey[]);
	}, []);

	useEffect(() => {
		list.run(async () => {
			await load();
			return undefined;
		});
	}, [load]);

	function close() {
		setDialog(null);
		action.reset();
	}

	const label = (passkey: Passkey) => passkey.name || "Unnamed passkey";

	return (
		<>
			<section className="flex flex-col gap-4 border-border border-t pt-8">
				<div className="flex items-start justify-between gap-4">
					<div className="space-y-1">
						<h2 className="font-semibold text-[15px]">Passkeys</h2>
						<p className="text-muted-foreground text-sm">
							Sign in with Touch ID, Face ID or a security key instead of a
							password.
						</p>
					</div>
					<Button
						variant="outline"
						size="sm"
						className="shrink-0"
						onClick={() => {
							action.reset();
							setDialog({ kind: "add" });
						}}
					>
						Add a passkey
					</Button>
				</div>
				<ActionFeedback error={list.error} />
				{passkeys?.length === 0 && (
					<p className="text-muted-foreground text-sm">
						You haven&apos;t added any passkeys yet.
					</p>
				)}
				{passkeys?.length ? (
					<ul
						aria-label="Your passkeys"
						className="flex flex-col divide-y divide-border border-border border-t"
					>
						{passkeys.map((passkey) => (
							<li
								key={passkey.id}
								className="flex min-h-12 items-center gap-4 py-2 text-sm"
							>
								<span className="min-w-0 flex-1 truncate font-medium">
									{label(passkey)}
								</span>
								<span className="w-56 shrink-0 text-muted-foreground">
									Added {formatDate(passkey.createdAt)}
									{passkey.backedUp ? " · synced" : ""}
								</span>
								<span className="flex shrink-0 items-center gap-1">
									<Button
										variant="ghost"
										size="sm"
										onClick={() => {
											action.reset();
											setDialog({ kind: "rename", passkey });
										}}
									>
										Rename
									</Button>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => {
											action.reset();
											setDialog({ kind: "delete", passkey });
										}}
									>
										Delete
									</Button>
								</span>
							</li>
						))}
					</ul>
				) : null}
			</section>
			<ActionDialog
				open={dialog?.kind === "add"}
				onOpenChange={(open) => !open && close()}
				title="Add a passkey"
				description="Give it a name you'll recognize, then follow your browser's prompt."
				submitLabel="Create passkey"
				pending={action.pending}
				error={action.error}
				onSubmit={(data) =>
					action.run(async () => {
						const result = await authClient.passkey.addPasskey({
							name: String(data.get("name")).trim() || defaultPasskeyName(),
						});
						if (result?.error) {
							const { message, code, status } = result.error as {
								message?: string;
								code?: string;
								status?: number;
							};
							throw new AuthError(
								/cancel|not allowed|abort|timed out/i.test(message ?? "")
									? "The passkey request was cancelled or timed out."
									: (message ?? "Couldn't add the passkey."),
								code,
								status,
							);
						}
						await load();
						close();
						return undefined;
					})
				}
			>
				<TextField
					label="Passkey name"
					name="name"
					defaultValue={dialog?.kind === "add" ? defaultPasskeyName() : ""}
					maxLength={64}
					required
					autoFocus
				/>
			</ActionDialog>
			<ActionDialog
				open={dialog?.kind === "rename"}
				onOpenChange={(open) => !open && close()}
				title="Rename passkey"
				submitLabel="Save"
				pending={action.pending}
				error={action.error}
				onSubmit={(data) =>
					action.run(async () => {
						if (dialog?.kind !== "rename") return undefined;
						await authResult(
							authClient.passkey.updatePasskey({
								id: dialog.passkey.id,
								name: String(data.get("name")).trim(),
							}),
						);
						await load();
						close();
						return undefined;
					})
				}
			>
				<TextField
					label="Passkey name"
					name="name"
					defaultValue={dialog?.kind === "rename" ? label(dialog.passkey) : ""}
					maxLength={64}
					required
					autoFocus
				/>
			</ActionDialog>
			<ActionDialog
				open={dialog?.kind === "delete"}
				onOpenChange={(open) => !open && close()}
				title="Delete passkey?"
				description={
					dialog?.kind === "delete"
						? `You won't be able to sign in with “${label(dialog.passkey)}” anymore. Also remove it from your device or password manager.`
						: undefined
				}
				submitLabel="Delete passkey"
				destructive
				pending={action.pending}
				error={action.error}
				onSubmit={() =>
					action.run(async () => {
						if (dialog?.kind !== "delete") return undefined;
						await authResult(
							authClient.passkey.deletePasskey({ id: dialog.passkey.id }),
						);
						await load();
						close();
						return undefined;
					})
				}
			/>
		</>
	);
}
