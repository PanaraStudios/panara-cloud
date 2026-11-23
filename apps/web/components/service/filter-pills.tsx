"use client";

import { OptionIcon } from "@/components/ui/option-icon";
import { optionMarks } from "@/lib/option-icons";
import { cn } from "@/lib/utils";

/** A light pill switch for a list's view or filter (All · Applications ·
    Compose, Table · Raw .env): the active pill is a muted chip, not ink. */
export function FilterPills<T extends string>({
	value,
	onValueChange,
	items,
	"aria-label": ariaLabel,
	autoIcon = true,
	className,
}: {
	value: T;
	onValueChange: (value: T) => void;
	items: readonly {
		value: T;
		label: string;
		/** A 16px mark before the label (a provider logo, a type glyph). */
		icon?: React.ReactNode;
		disabled?: boolean;
	}[];
	"aria-label": string;
	/** Pills without an `icon` get the mark of their label ("Table",
	    "Docker Compose"); false for pills whose labels are data. */
	autoIcon?: boolean;
	className?: string;
}) {
	const marks = autoIcon
		? optionMarks(items.map((item) => (item.icon ? undefined : item.label)))
		: null;
	return (
		<fieldset
			aria-label={ariaLabel}
			className={cn(
				"m-0 flex h-8 min-w-0 items-center gap-0.5 rounded-lg border bg-background p-0.5",
				className,
			)}
		>
			{items.map((item, index) => {
				const mark = marks?.[index];
				const icon =
					item.icon ?? (mark ? <OptionIcon compact mark={mark} /> : null);
				return (
					<button
						key={item.value}
						type="button"
						aria-pressed={value === item.value}
						disabled={item.disabled}
						onClick={() => onValueChange(item.value)}
						className={cn(
							"flex h-full items-center gap-1.5 rounded-md px-3 font-medium text-[13px] text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5 [&_svg]:shrink-0",
							value === item.value && "bg-muted text-foreground",
							icon && !(mark && "tone" in mark) && "pl-2.5",
						)}
					>
						{icon}
						{item.label}
					</button>
				);
			})}
		</fieldset>
	);
}
