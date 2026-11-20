"use client";

import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useFormShellPage } from "@/components/ui-kit/form-shell";
import {
	type BadgeTone,
	toneDotClassName,
} from "@/components/ui-kit/primitives";
import { cn } from "@/lib/utils";

/** State in a table cell: a coloured dot, then the word at the row's size. */
export function StatusDot({
	tone,
	className,
	children,
}: {
	tone: BadgeTone;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-2 whitespace-nowrap",
				className,
			)}
		>
			<span
				aria-hidden="true"
				className={cn("size-1.5 rounded-full", toneDotClassName(tone))}
			/>
			{children}
		</span>
	);
}

/** A list that is still loading: the space its table will take. */
export function ListLoading() {
	return (
		<Skeleton
			role="status"
			aria-label="Loading"
			className="h-36 w-full rounded-xl"
		/>
	);
}

/** One section of a form page: hairline, h2, one muted line, then fields. */
export function FormSection({
	id,
	title,
	icon: Icon,
	description,
	action,
	className,
	children,
}: {
	/** An anchor other pages link to (`/settings/general#panel-backups`). */
	id?: string;
	title: string;
	/** A small glyph before the title, to recognise the section at a glance. */
	icon?: LucideIcon;
	description?: React.ReactNode;
	action?: React.ReactNode;
	className?: string;
	children?: React.ReactNode;
}) {
	return (
		<section
			id={id}
			className={cn(
				"flex min-w-0 flex-col gap-4 border-border border-t pt-8",
				className,
			)}
		>
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0 space-y-1">
					<h2 className="flex items-center gap-2 font-semibold text-[15px]">
						{Icon ? (
							<Icon
								aria-hidden="true"
								className="size-4 shrink-0 text-muted-foreground"
							/>
						) : null}
						{title}
					</h2>
					{description ? (
						<p className="text-muted-foreground text-sm">{description}</p>
					) : null}
				</div>
				{action ? <div className="shrink-0">{action}</div> : null}
			</div>
			{children}
		</section>
	);
}

/** Rows of a section, split by hairlines: what it is on the left, its one
    control on the right. */
export function SettingRows({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div
			className={cn(
				"flex flex-col divide-y divide-border border-border border-t",
				className,
			)}
		>
			{children}
		</div>
	);
}

export function SettingRow({
	title,
	description,
	htmlFor,
	children,
}: {
	title: React.ReactNode;
	description?: React.ReactNode;
	/** The id of the control, when the title labels it (a switch). */
	htmlFor?: string;
	children?: React.ReactNode;
}) {
	const Title = htmlFor ? "label" : "p";
	return (
		<div className="flex min-h-14 items-center gap-4 py-2.5">
			<div className="min-w-0 flex-1">
				<Title htmlFor={htmlFor} className="block font-medium text-sm">
					{title}
				</Title>
				{description ? (
					<div className="text-muted-foreground text-sm">{description}</div>
				) : null}
			</div>
			{children ? (
				<div className="flex shrink-0 items-center gap-2">{children}</div>
			) : null}
		</div>
	);
}

/** A failed save or test: a plain sentence, the raw message under it. */
export function FormError({
	title,
	message,
	className,
}: {
	title: string;
	message?: string | null;
	className?: string;
}) {
	return (
		<div role="alert" className={cn("flex flex-col gap-1", className)}>
			<p className="text-destructive text-sm">{title}</p>
			{message ? (
				<p className="break-words font-mono text-[13px] text-muted-foreground">
					{message}
				</p>
			) : null}
		</div>
	);
}

/** Cancel on a form page: back to the list. A dialog closes itself. */
export function FormCancel({ href }: { href: string }) {
	if (!useFormShellPage()) return null;
	return (
		<Button variant="ghost" nativeButton={false} render={<Link href={href} />}>
			Cancel
		</Button>
	);
}
