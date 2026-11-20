"use client";

import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props extends React.ComponentPropsWithoutRef<"div"> {
	icon?: React.ReactNode;
	type?: "info" | "success" | "warning" | "error";
}

// Monochrome: no tinted panel. The icon carries the state colour, the text
// stays ink (docs/design.md).
const iconMap = {
	info: {
		className: "text-muted-foreground [&_svg]:text-muted-foreground",
		icon: Info,
	},
	success: {
		className: "text-foreground [&_svg]:text-success",
		icon: CheckCircle2,
	},
	warning: {
		className: "text-foreground [&_svg]:text-warning",
		icon: AlertCircle,
	},
	error: {
		className: "text-foreground [&_svg]:text-destructive",
		icon: AlertTriangle,
	},
};

export function AlertBlock({
	type = "info",
	icon,
	children,
	className,
	...props
}: Props) {
	const { className: iconClassName, icon: Icon } = iconMap[type];
	return (
		<div
			data-slot="alert-block"
			data-type={type}
			{...props}
			className={cn(
				"flex flex-row items-start gap-2.5 [&_svg]:size-4",
				iconClassName,
				className,
			)}
		>
			<div className="shrink-0 mt-0.5">{icon || <Icon />}</div>
			<div className="flex-1 min-w-0">
				<span className="text-sm text-current wrap-break-word overflow-wrap-anywhere whitespace-pre-wrap">
					{children}
				</span>
			</div>
		</div>
	);
}
