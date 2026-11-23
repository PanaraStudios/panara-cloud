"use client";

import type { LucideIcon } from "lucide-react";

import { OptionIcon } from "@/components/ui/option-icon";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { optionMarks } from "@/lib/option-icons";
import { cn } from "@/lib/utils";

export type SegmentedItem<T extends string> = {
	value: T;
	label: string;
	icon?: LucideIcon;
};

/** Single-choice toggle group. Base UI models the value as an array, so this
    keeps the array plumbing in one place. An item with an `icon` shows the
    icon alone; the others get the mark of their label ("Member", "Admin"). */
export function SegmentedToggle<T extends string>({
	value,
	onValueChange,
	items,
	size = "sm",
	orientation = "horizontal",
	className,
	itemClassName,
	"aria-label": ariaLabel,
	testIdPrefix,
}: {
	value: T;
	onValueChange: (value: T) => void;
	items: readonly SegmentedItem<T>[];
	size?: "sm" | "default";
	orientation?: "horizontal" | "vertical";
	className?: string;
	itemClassName?: string;
	"aria-label": string;
	testIdPrefix?: string;
}) {
	const marks = optionMarks(
		items.map((item) => (item.icon ? undefined : item.label)),
	);
	return (
		<ToggleGroup
			variant={orientation === "vertical" ? "default" : "outline"}
			size={size}
			spacing={orientation === "vertical" ? 2 : 0}
			orientation={orientation}
			aria-label={ariaLabel}
			value={[value]}
			onValueChange={(next) => {
				const selected = next[0] as T | undefined;
				if (selected) onValueChange(selected);
			}}
			/* Base UI only writes `data-orientation`, so the stacking is set here
         rather than relying on the group's own vertical variants. */
			className={cn(
				orientation === "vertical"
					? "flex-col items-stretch"
					: "w-full flex-row",
				className,
			)}
		>
			{items.map((item, index) => {
				const Icon = item.icon;
				const mark = marks?.[index];
				return (
					<ToggleGroupItem
						key={item.value}
						value={item.value}
						aria-label={item.label}
						title={item.label}
						data-testid={
							testIdPrefix ? `${testIdPrefix}-${item.value}` : undefined
						}
						className={cn(
							orientation === "horizontal" && "flex-1",
							itemClassName,
						)}
					>
						{Icon ? (
							<Icon />
						) : (
							<>
								{mark ? <OptionIcon compact mark={mark} /> : null}
								{item.label}
							</>
						)}
					</ToggleGroupItem>
				);
			})}
		</ToggleGroup>
	);
}
