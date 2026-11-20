import { cn } from "@/lib/utils";

/** The body of a form page: sections 32px apart, a hairline between them. */
export function FormSections({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex min-w-0 flex-col gap-8 [&>*+*]:border-border [&>*+*]:border-t [&>*+*]:pt-8",
				className,
			)}
		>
			{children}
		</div>
	);
}

export function FormSection({
	id,
	title,
	description,
	actions,
	children,
}: {
	id?: string;
	title: string;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	children?: React.ReactNode;
}) {
	return (
		<section id={id} className="flex min-w-0 scroll-mt-6 flex-col gap-4">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0 space-y-1">
					<h2 className="font-semibold text-[15px]">{title}</h2>
					{description ? (
						<p className="text-muted-foreground text-sm">{description}</p>
					) : null}
				</div>
				{actions ? (
					<div className="flex shrink-0 items-center gap-2">{actions}</div>
				) : null}
			</div>
			{children}
		</section>
	);
}

/** A setting that is one action: what it does on the left, its button on the
    right. Stack them in a `divide-y divide-border` list. */
export function ActionRow({
	title,
	description,
	children,
}: {
	title: string;
	description?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
			<div className="min-w-0 space-y-0.5">
				<h3 className="font-medium text-sm">{title}</h3>
				{description ? (
					<p className="text-muted-foreground text-sm">{description}</p>
				) : null}
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}
