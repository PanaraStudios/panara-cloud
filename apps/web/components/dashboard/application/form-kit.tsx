"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/* The one layout the application and compose settings forms share: a flat
   section (h2, one muted line, content), fields 16px apart, switch rows
   without a box, and the save row right-aligned at the end. */

/** One section of a settings page: heading, one muted line, content. */
export function FormSection({
	title,
	description,
	actions,
	className,
	children,
}: {
	title?: React.ReactNode;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	className?: string;
	children?: React.ReactNode;
}) {
	return (
		<section className={cn("flex min-w-0 flex-col gap-4", className)}>
			{title || description || actions ? (
				<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
					<div className="min-w-0 space-y-1">
						{title ? (
							<h2 className="font-semibold text-[15px]">{title}</h2>
						) : null}
						{description ? (
							<p className="text-muted-foreground text-sm">{description}</p>
						) : null}
					</div>
					{actions ? (
						<div className="flex shrink-0 flex-wrap items-center gap-2">
							{actions}
						</div>
					) : null}
				</div>
			) : null}
			{children}
		</section>
	);
}

/** The save row of a form: right-aligned, last. */
export function FormActions({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div className={cn("flex items-center justify-end gap-2", className)}>
			{children}
		</div>
	);
}

/** A section form's submit: quiet, and disabled until there is a change. */
export function SaveButton({
	dirty = true,
	disabled,
	children = "Save",
	...props
}: Omit<React.ComponentProps<typeof Button>, "type" | "variant"> & {
	dirty?: boolean;
}) {
	return (
		<Button type="submit" disabled={disabled || !dirty} {...props}>
			{children}
		</Button>
	);
}

/** One muted sentence: an empty list, a note, a "connect this first" line. */
export function FormNote({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<p className={cn("text-muted-foreground text-sm", className)}>{children}</p>
	);
}

/** A failed load or save: a plain sentence, the raw message small under it. */
export function FormError({
	title = "Something went wrong.",
	detail,
	className,
}: {
	title?: string;
	detail?: React.ReactNode;
	className?: string;
}) {
	return (
		<div role="alert" className={cn("min-w-0 text-sm", className)}>
			<p>{title}</p>
			{detail ? (
				<p className="mt-1 break-words font-mono text-[13px] text-muted-foreground">
					{detail}
				</p>
			) : null}
		</div>
	);
}

/** A link inside muted text. */
export const NOTE_LINK =
	"font-medium text-foreground underline-offset-4 hover:underline";
