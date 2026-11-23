"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PendingEvent } from "./use-section-pending";

/* The parts of one settings section (Details, Source, Build under General):
   32px apart, no rule between them. The hairlines belong to the sections of
   the page, so the two levels never look alike. */
const STACK = "flex min-w-0 flex-col gap-8";

/* Some sections still render the older `Card` forms. Inside a section they
   read as its flat parts: no surface, inset or shadow, the part heading size,
   and the form's submit row at the end of its part. */
const FLAT = cn(
	STACK,
	"[&_[data-slot=card]]:gap-4 [&_[data-slot=card]]:overflow-visible [&_[data-slot=card]]:rounded-none [&_[data-slot=card]]:bg-transparent [&_[data-slot=card]]:bg-none [&_[data-slot=card]]:px-0! [&_[data-slot=card]]:py-0 [&_[data-slot=card]]:shadow-none [&_[data-slot=card]]:ring-0",
	"[&_[data-slot=card-header]]:px-0 [&_[data-slot=card-content]]:px-0 [&_[data-slot=card-footer]]:border-t-0 [&_[data-slot=card-footer]]:bg-transparent [&_[data-slot=card-footer]]:px-0",
	"[&_[data-slot=card-title]]:font-sans [&_[data-slot=card-title]]:text-sm! [&_[data-slot=card-title]]:font-semibold [&_[data-slot=card-title]]:leading-snug",
	"[&_[data-slot=card-description]]:text-sm",
	"[&_[data-slot=card]_[data-slot=card]]:py-0",
	// A part's own heading sits one step under the section's.
	"[&_h2]:text-sm!",
	// A grid item is as wide as its widest content unless told otherwise,
	// which pushes a form with a pill row past a phone's edge.
	"[&_form.grid>*]:min-w-0",
	// One heading per section: a section made of a single card drops the
	// card's own title (the section already has one).
	"[&>[data-slot=card]:only-child>[data-slot=card-header]_[data-slot=card-title]]:hidden [&>[data-slot=card]:only-child>[data-slot=card-header]_[data-slot=card-description]]:hidden",
	"[&>[data-slot=card]:only-child>[data-slot=card-header]:not(:has(button)):not(:has(a))]:hidden",
	// No decorative icons next to titles (buttons keep theirs).
	"[&_[data-slot=card-header]_:not(button):not(a)>svg]:hidden",
	// Info notes read as plain muted text, not tinted boxes.
	"[&_[data-slot=alert-block][data-type=info]]:bg-transparent [&_[data-slot=alert-block][data-type=info]]:px-0 [&_[data-slot=alert-block][data-type=info]]:py-0 [&_[data-slot=alert-block][data-type=info]]:text-muted-foreground",
);

export function SettingsBody({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return <div className={cn(FLAT, className)}>{children}</div>;
}

/** The parts of one settings form, 32px apart. */
export function SettingsStack({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return <div className={cn(STACK, className)}>{children}</div>;
}

/** One part of a settings section: heading, muted line, actions, content. */
export function SettingsBlock({
	id,
	title,
	description,
	actions,
	children,
}: {
	id?: string;
	title?: string;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	children?: React.ReactNode;
}) {
	return (
		<section id={id} className="flex min-w-0 scroll-mt-6 flex-col gap-4">
			{title || description || actions ? (
				<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
					<div className="min-w-0 space-y-1">
						{title ? (
							<h2 className="font-semibold text-[15px] leading-snug">
								{title}
							</h2>
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

/** "Not deployed" marker for a row or a block with staged changes. */
export function NotDeployedBadge({ className }: { className?: string }) {
	return (
		<Badge variant="warning" dot className={className}>
			Not deployed
		</Badge>
	);
}

/** Staged changes of this section, waiting for the next deploy: one quiet
    line (the header's "Deploy N changes" button applies them). */
export function PendingNotice({ events }: { events: readonly PendingEvent[] }) {
	if (events.length === 0) return null;
	const latest = events[0]?.summary;
	return (
		<p className="flex min-w-0 items-center gap-2 text-sm">
			<span className="size-1.5 shrink-0 rounded-full bg-warning" />
			<span className="shrink-0 font-medium text-warning">
				{events.length === 1
					? "1 change not deployed"
					: `${events.length} changes not deployed`}
			</span>
			{latest ? (
				<span className="min-w-0 truncate text-muted-foreground">
					· {latest}
					{events.length > 1 ? ` and ${events.length - 1} more` : ""}
				</span>
			) : null}
		</p>
	);
}
