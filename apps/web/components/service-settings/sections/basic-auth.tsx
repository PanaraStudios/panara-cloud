"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import {
	EyeIcon,
	EyeOffIcon,
	KeyRoundIcon,
	LockIcon,
	PlusIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useService } from "@/components/service/service-context";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	ConfirmDialog,
	EmptyState,
	MoreMenu,
	ResourceTable,
	Th,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { countLabel, DRAFT_ROW, Note, SectionToolbar, UnsavedBar } from "./kit";
import type { SectionProps } from "./registry";

type Draft = {
	// The user whose password is being replaced, or null for a new one.
	userId: string | null;
	username: string;
	password: string;
};

function generatePassword() {
	const alphabet =
		"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_";
	const bytes = crypto.getRandomValues(new Uint8Array(20));
	return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

/** Basic auth: users who must sign in before Traefik lets a request
    through. Passwords are hashed on save, so they can be replaced, not
    shown. */
export function BasicAuthSection({ id }: SectionProps) {
	const { service } = useService();
	const users = useQuery(api.infra.basicAuth.listByOwner, {
		owner: { kind: "application", id },
	});
	const create = useAction(api.infra.basicAuth.create);
	const update = useAction(api.infra.basicAuth.update);
	const remove = useMutation(api.infra.basicAuth.remove);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [reveal, setReveal] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<string | null>(null);

	const valid =
		!!draft && draft.username.trim().length > 0 && draft.password.length > 0;

	const save = useCallback(async () => {
		if (!draft || !valid) return;
		setSaving(true);
		setError(null);
		try {
			if (draft.userId) {
				await update({
					userId: draft.userId as Id<"basicAuthUsers">,
					username: draft.username.trim(),
					password: draft.password,
				});
			} else {
				await create({
					owner: { kind: "application", id },
					username: draft.username.trim(),
					password: draft.password,
				});
			}
			toast.success(draft.userId ? "Password replaced" : "User added");
			setDraft(null);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setSaving(false);
		}
	}, [draft, valid, update, create, id]);

	if (users === undefined) return null;

	const startAdd = () => {
		setError(null);
		setReveal(false);
		setDraft({ userId: null, username: "", password: "" });
	};

	const keys = (event: React.KeyboardEvent) => {
		if (event.key === "Enter") void save();
		if (event.key === "Escape") setDraft(null);
	};

	const draftRow = draft ? (
		<TableRow key="draft" className={DRAFT_ROW}>
			<TableCell className="py-2">
				<Input
					autoFocus={draft.userId === null}
					aria-label="Username"
					placeholder="username"
					autoComplete="off"
					value={draft.username}
					onChange={(event) =>
						setDraft({ ...draft, username: event.target.value })
					}
					onKeyDown={keys}
					className="h-8! font-mono text-[13px]"
				/>
			</TableCell>
			<TableCell className="py-2">
				<InputGroup className="h-8!">
					<InputGroupInput
						autoFocus={draft.userId !== null}
						aria-label="Password"
						type={reveal ? "text" : "password"}
						autoComplete="new-password"
						placeholder={draft.userId ? "new password" : "password"}
						value={draft.password}
						onChange={(event) =>
							setDraft({ ...draft, password: event.target.value })
						}
						onKeyDown={keys}
						className="font-mono text-[13px]"
					/>
					<InputGroupAddon align="inline-end">
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label={reveal ? "Hide password" : "Show password"}
							onClick={() => setReveal((value) => !value)}
						>
							{reveal ? <EyeOffIcon /> : <EyeIcon />}
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="xs"
							onClick={() => {
								setReveal(true);
								setDraft({ ...draft, password: generatePassword() });
							}}
						>
							Generate
						</Button>
					</InputGroupAddon>
				</InputGroup>
			</TableCell>
			<TableCell className="py-2 text-right">
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Cancel"
					onClick={() => setDraft(null)}
				>
					<XIcon />
				</Button>
			</TableCell>
		</TableRow>
	) : null;

	const add = (
		<Button variant="outline" onClick={startAdd} disabled={!!draft}>
			<PlusIcon data-icon="inline-start" />
			Add user
		</Button>
	);

	return (
		<div className="flex flex-col gap-4">
			{users.length === 0 && !draft ? (
				<EmptyState
					icon={LockIcon}
					title="Open to everyone"
					description={`Add a user to put ${service.name} behind a password. Handy for staging.`}
				>
					{add}
				</EmptyState>
			) : (
				<>
					<SectionToolbar actions={add}>
						{users.length > 0 ? countLabel(users.length, "user") : "New user"}
					</SectionToolbar>
					<ResourceTable
						headers={
							<>
								<Th className="w-[38%]">Username</Th>
								<Th>Password</Th>
								<Th className="w-12" />
							</>
						}
					>
						{users.map((user) =>
							draft?.userId === user._id ? (
								draftRow
							) : (
								<TableRow key={user._id}>
									<TableCell className="font-mono text-[13px]">
										{user.username}
									</TableCell>
									<TableCell className="text-muted-foreground">
										<span className="font-mono tracking-widest">
											••••••••••••
										</span>
										<span className="ml-2 text-xs">hashed</span>
									</TableCell>
									<TableCell className="text-right">
										<MoreMenu>
											<DropdownMenuItem
												onClick={() => {
													setError(null);
													setReveal(false);
													setDraft({
														userId: user._id,
														username: user.username,
														password: "",
													});
												}}
											>
												<KeyRoundIcon className="text-muted-foreground" />
												Replace password
											</DropdownMenuItem>
											<DropdownMenuItem
												variant="destructive"
												onClick={() => setDeleting(user._id)}
											>
												<Trash2Icon className="text-muted-foreground" />
												Remove user
											</DropdownMenuItem>
										</MoreMenu>
									</TableCell>
								</TableRow>
							),
						)}
						{draft && draft.userId === null ? draftRow : null}
					</ResourceTable>
				</>
			)}
			{error ? <Note tone="error">{error}</Note> : null}
			<Note>
				Applies to every domain of {service.name} and to its preview
				deployments. Passwords are stored hashed, in a Traefik middleware.
			</Note>
			<UnsavedBar
				count={draft ? 1 : 0}
				hint="applies with a reload"
				onDiscard={() => setDraft(null)}
				onSave={() => void save()}
				saving={saving}
				disabled={!valid}
			/>
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(open) => {
					if (!open) setDeleting(null);
				}}
				title="Remove user?"
				description="They can no longer sign in once Traefik reloads."
				onConfirm={async () => {
					if (!deleting) return;
					await remove({ userId: deleting as Id<"basicAuthUsers"> });
					toast.success("User removed");
					setDeleting(null);
				}}
			/>
		</div>
	);
}
