"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import {
	ArrowRightIcon,
	PencilIcon,
	PlusIcon,
	SignpostIcon,
	Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { FilterPills } from "@/components/service/filter-pills";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	ConfirmDialog,
	EmptyState,
	MoreMenu,
	ResourceTable,
	Th,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { cn } from "@/lib/utils";
import { ChangeTag, countLabel, DRAFT_ROW, SectionToolbar } from "./kit";
import type { SectionProps } from "./registry";

type Redirect = { regex: string; replacement: string; permanent: boolean };

const PRESETS: { id: string; label: string; redirect: Redirect | null }[] = [
	{
		id: "to-www",
		label: "Redirect to www",
		redirect: {
			regex: "^https?://(?:www.)?(.+)",
			replacement: "https://www.${1}",
			permanent: true,
		},
	},
	{
		id: "to-non-www",
		label: "Redirect to non-www",
		redirect: {
			regex: "^https?://www.(.+)",
			replacement: "https://${1}",
			permanent: true,
		},
	},
	{ id: "custom", label: "Custom", redirect: null },
];

/** Add or edit one redirect: a preset or a regex of your own (3 fields). */
function RedirectDialog({
	open,
	onOpenChange,
	applicationId,
	editing,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	applicationId: string;
	editing: ({ _id: string } & Redirect) | null;
}) {
	const create = useMutation(api.infra.redirects.create);
	const update = useMutation(api.infra.redirects.update);
	const [preset, setPreset] = useState(editing ? "custom" : "to-www");
	const [value, setValue] = useState<Redirect>(
		editing ?? (PRESETS[0]?.redirect as Redirect),
	);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!value.regex.trim() || !value.replacement.trim()) {
			setError("Both From and To are required.");
			return;
		}
		setSaving(true);
		setError(null);
		try {
			if (editing) {
				await update({
					redirectId: editing._id as Id<"redirects">,
					...value,
				});
			} else {
				await create({
					owner: { kind: "application", id: applicationId },
					...value,
				});
			}
			toast.success(editing ? "Redirect updated" : "Redirect added");
			onOpenChange(false);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<form onSubmit={submit} className="contents">
					<DialogHeader>
						<DialogTitle>
							{editing ? "Edit redirect" : "Add redirect"}
						</DialogTitle>
						<DialogDescription>
							Start from a preset or write your own.
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-5">
						<FilterPills
							aria-label="Preset"
							className="w-fit max-w-full overflow-x-auto"
							value={preset}
							onValueChange={(next) => {
								setPreset(next);
								const redirect = PRESETS.find(
									(item) => item.id === next,
								)?.redirect;
								if (redirect) setValue(redirect);
							}}
							items={PRESETS.map((item) => ({
								value: item.id,
								label: item.label,
							}))}
						/>
						<div className="flex flex-col gap-2">
							<Label htmlFor="redirect-from">From (regex)</Label>
							<Input
								id="redirect-from"
								className="font-mono"
								placeholder="^https?://example\.com/(.*)"
								value={value.regex}
								onChange={(event) => {
									setPreset("custom");
									setValue({ ...value, regex: event.target.value });
								}}
							/>
						</div>
						<div className="flex flex-col gap-2">
							<Label htmlFor="redirect-to">To</Label>
							<Input
								id="redirect-to"
								className="font-mono"
								placeholder="https://www.example.com/${1}"
								value={value.replacement}
								onChange={(event) => {
									setPreset("custom");
									setValue({ ...value, replacement: event.target.value });
								}}
							/>
						</div>
						<div className="flex items-center justify-between gap-4">
							<div className="flex flex-col gap-0.5">
								<Label htmlFor="redirect-permanent">Permanent (301)</Label>
								<span className="text-muted-foreground text-sm">
									{value.permanent
										? "Browsers and search engines cache it"
										: "Temporary (302): nothing is cached"}
								</span>
							</div>
							<Switch
								id="redirect-permanent"
								checked={value.permanent}
								onCheckedChange={(checked) =>
									setValue({ ...value, permanent: checked })
								}
							/>
						</div>
						{error ? <p className="text-destructive text-sm">{error}</p> : null}
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button type="submit" isLoading={saving}>
							{editing ? "Save redirect" : "Add redirect"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export function RedirectsSection({ id, pending }: SectionProps) {
	const redirects = useQuery(api.infra.redirects.listByOwner, {
		owner: { kind: "application", id },
	});
	const remove = useMutation(api.infra.redirects.remove);
	const [dialog, setDialog] = useState<{
		key: number;
		editing: ({ _id: string } & Redirect) | null;
	} | null>(null);
	const [deleting, setDeleting] = useState<string | null>(null);

	if (redirects === undefined) return null;
	const changed = pending.length > 0;
	const openAdd = () => setDialog({ key: Date.now(), editing: null });

	const add = (
		<Button variant="outline" onClick={openAdd}>
			<PlusIcon data-icon="inline-start" />
			Add redirect
		</Button>
	);

	return (
		<div className="flex flex-col gap-4">
			{redirects.length === 0 ? (
				<EmptyState
					icon={SignpostIcon}
					title="No redirects"
					description="Send www to the apex domain, old paths to new ones, and so on."
				>
					{add}
				</EmptyState>
			) : (
				<>
					<SectionToolbar actions={add}>
						{countLabel(redirects.length, "redirect")}
					</SectionToolbar>
					<ResourceTable
						headers={
							<>
								<Th>From (regex)</Th>
								<Th>To</Th>
								<Th className="w-24">Type</Th>
								{changed ? <Th className="w-28" /> : null}
								<Th className="w-12" />
							</>
						}
					>
						{redirects.map((redirect) => (
							<TableRow key={redirect._id} className={cn(changed && DRAFT_ROW)}>
								<TableCell className="max-w-80 truncate font-mono text-[13px]">
									{redirect.regex}
								</TableCell>
								<TableCell className="max-w-80">
									<span className="flex min-w-0 items-center gap-2">
										<ArrowRightIcon
											aria-hidden="true"
											className="size-4 shrink-0 text-muted-foreground"
										/>
										<span className="truncate font-mono text-[13px]">
											{redirect.replacement}
										</span>
									</span>
								</TableCell>
								<TableCell
									title={redirect.permanent ? "Permanent" : "Temporary"}
									className="tabular-nums"
								>
									{redirect.permanent ? "301" : "302"}
								</TableCell>
								{changed ? (
									<TableCell>
										<ChangeTag label="Not deployed" />
									</TableCell>
								) : null}
								<TableCell className="text-right">
									<MoreMenu>
										<DropdownMenuItem
											onClick={() =>
												setDialog({
													key: Date.now(),
													editing: {
														_id: redirect._id,
														regex: redirect.regex,
														replacement: redirect.replacement,
														permanent: redirect.permanent,
													},
												})
											}
										>
											<PencilIcon className="text-muted-foreground" />
											Edit
										</DropdownMenuItem>
										<DropdownMenuItem
											variant="destructive"
											onClick={() => setDeleting(redirect._id)}
										>
											<Trash2Icon className="text-muted-foreground" />
											Delete
										</DropdownMenuItem>
									</MoreMenu>
								</TableCell>
							</TableRow>
						))}
					</ResourceTable>
				</>
			)}
			{dialog ? (
				<RedirectDialog
					key={dialog.key}
					open
					onOpenChange={(open) => {
						if (!open) setDialog(null);
					}}
					applicationId={id}
					editing={dialog.editing}
				/>
			) : null}
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(open) => {
					if (!open) setDeleting(null);
				}}
				title="Delete redirect?"
				description="The redirect keeps working until the next deploy."
				onConfirm={async () => {
					if (!deleting) return;
					await remove({ redirectId: deleting as Id<"redirects"> });
					toast.success("Redirect deleted");
					setDeleting(null);
				}}
			/>
		</div>
	);
}
