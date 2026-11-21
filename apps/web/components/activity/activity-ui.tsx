"use client";

import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { PageTabs } from "@/components/ui-kit/page-tabs";
import { PageHeader } from "@/components/ui-kit/primitives";
import { activityNav, visibleItems } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";

/** Activity's header and the views this member may open as tabs, then the
    open view. `actions` is the view's header button. */
export function ActivityPage({
	actions,
	children,
}: {
	actions?: React.ReactNode;
	children: React.ReactNode;
}) {
	const permissions = usePermissions();
	return (
		<div className="flex w-full flex-col gap-6 pb-10">
			<div className="flex flex-col gap-5">
				<PageHeader
					title="Activity"
					description="Deployments, scheduled jobs and requests across your projects and servers."
				>
					{actions}
				</PageHeader>
				<PageTabs
					label="Activity"
					tabs={visibleItems(activityNav, permissions).map((item) => ({
						title: item.title,
						href: item.url,
					}))}
				/>
			</div>
			{children}
		</div>
	);
}

/** "Project  All ▾": a compact filter select with its label inside. */
export function FilterSelect({
	label,
	value,
	onValueChange,
	options,
	allLabel = "All",
}: {
	label: string;
	value: string;
	onValueChange: (value: string) => void;
	options: { value: string; label: string }[];
	allLabel?: string;
}) {
	return (
		<Select value={value} onValueChange={onValueChange}>
			<SelectTrigger aria-label={label}>
				<span className="text-muted-foreground">{label}</span>
				<span className="font-medium">
					<SelectValue />
				</span>
			</SelectTrigger>
			<SelectContent align="start">
				<SelectItem value="all">{allLabel}</SelectItem>
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/** A two-line cell: main text, muted line under it. */
export function TwoLine({
	primary,
	secondary,
	className,
}: {
	primary: React.ReactNode;
	secondary?: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex min-w-0 flex-col", className)}>
			<span className="truncate">{primary}</span>
			{secondary ? (
				<span className="truncate text-[13px] text-muted-foreground leading-4">
					{secondary}
				</span>
			) : null}
		</div>
	);
}
