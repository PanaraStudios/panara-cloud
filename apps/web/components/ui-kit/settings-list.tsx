"use client";

import {
	EllipsisIcon,
	type LucideIcon,
	PencilIcon,
	PlusIcon,
	Trash2Icon,
} from "lucide-react";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/ui-kit/primitives";
import Link from "@/lib/router/link";

/** Header of a Settings list page: title, one line, the primary add link. */
export function SettingsListHeader({
	title,
	description,
	addHref,
	addLabel,
	children,
}: {
	title: string;
	description: string;
	addHref?: string;
	addLabel?: string;
	children?: React.ReactNode;
}) {
	return (
		<PageHeader title={title} description={description}>
			{children}
			{addHref && addLabel ? (
				<Button nativeButton={false} render={<Link href={addHref} />}>
					<PlusIcon data-icon="inline-start" />
					{addLabel}
				</Button>
			) : null}
		</PageHeader>
	);
}

/** Dashed empty state under a Settings list header. */
export function SettingsEmpty({
	icon: Icon,
	title,
	description,
}: {
	icon: LucideIcon;
	title: string;
	description: string;
}) {
	return (
		<div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center">
			<Icon className="size-5 text-muted-foreground" />
			<p className="font-medium text-sm">{title}</p>
			<p className="max-w-md text-muted-foreground text-sm">{description}</p>
		</div>
	);
}

/** Row ⋯ menu: edit page link, extra items, and a confirmed delete. */
export function RowMenu({
	label,
	editHref,
	children,
	onDelete,
	deleteTitle,
	deleteDescription,
}: {
	label: string;
	editHref?: string;
	children?: React.ReactNode;
	onDelete?: () => Promise<void>;
	deleteTitle?: string;
	deleteDescription?: string;
}) {
	if (!editHref && !children && !onDelete) return null;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={`Actions for ${label}`}
					/>
				}
			>
				<EllipsisIcon />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{editHref ? (
					<DropdownMenuItem
						nativeButton={false}
						render={<Link href={editHref} />}
					>
						<PencilIcon />
						Edit
					</DropdownMenuItem>
				) : null}
				{children}
				{onDelete ? (
					<DialogAction
						title={deleteTitle ?? `Delete ${label}?`}
						description={deleteDescription ?? "This can't be undone."}
						type="destructive"
						confirmLabel="Delete"
						onClick={onDelete}
					>
						<DropdownMenuItem variant="destructive" closeOnClick={false}>
							<Trash2Icon />
							Delete
						</DropdownMenuItem>
					</DialogAction>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
