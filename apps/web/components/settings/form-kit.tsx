"use client";

import type { LucideIcon } from "lucide-react";
import { createContext, useContext } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useFormShellPage } from "@/components/ui-kit/form-shell";
import {
	type BadgeTone,
	PageHeader,
	toneDotClassName,
} from "@/components/ui-kit/primitives";
import { useActiveSection } from "@/components/ui-kit/settings-page";
import Link from "@/lib/router/link";
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

type PageTitle = { title?: string; description?: React.ReactNode };
const SectionPageContext = createContext<PageTitle | null>(null);

/** A page that is one `FormSection`: the section's title and line become the
    page's header (or the ones given here), so it is not titled twice. */
export function SectionPage({
	title,
	description,
	children,
}: PageTitle & { children: React.ReactNode }) {
	return (
		<SectionPageContext value={{ title, description }}>
			{children}
		</SectionPageContext>
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
	const page = useContext(SectionPageContext);
	const active = useActiveSection();
	const listed = active !== null && id !== undefined;
	if (page) {
		return (
			<div id={id} className="flex w-full min-w-0 flex-col gap-6">
				<PageHeader
					title={page.title ?? title}
					description={page.description ?? description}
				>
					{action}
				</PageHeader>
				<SectionPageContext value={null}>
					<div className={cn("flex min-w-0 flex-col gap-4", className)}>
						{children}
					</div>
				</SectionPageContext>
			</div>
		);
	}
	return (
		<section
			id={id}
			hidden={listed && id !== active}
			className={cn(
				"min-w-0 flex-col gap-4",
				// Inside a `SettingsLayout` only the open section shows, so
				// nothing sits above it to be ruled off from.
				listed
					? id === active &&
							"flex motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:animate-in motion-safe:duration-200"
					: "flex border-border border-t pt-8",
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

/** The fields of a form, side by side as the space allows: one column in a
    dialog, two on a page, three on a wide one. A textarea, an editor or
    anything long takes `col-span-full`. */
export function FieldGrid({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	return (
		// A grid whose fields are all conditional must not leave a gap when none show.
		<div className="@container min-w-0 has-[>:empty]:hidden">
			<div
				className={cn(
					"grid items-start gap-4 @lg:grid-cols-2 @6xl:grid-cols-3",
					className,
				)}
			>
				{children}
			</div>
		</div>
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
