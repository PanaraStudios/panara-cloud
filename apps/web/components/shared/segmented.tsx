"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	type BadgeTone,
	toneDotClassName,
} from "@/components/ui-kit/primitives";
import { cn } from "@/lib/utils";

/** One choice out of a few, as the kit's pill list: a list filter
    (All · Applications · Compose) or a form switch (GitHub · GitLab · Git URL). */
export function Segmented<Value extends string>({
	value,
	onValueChange,
	items,
	"aria-label": ariaLabel,
	className,
}: {
	value: Value;
	onValueChange: (value: Value) => void;
	items: readonly {
		value: Value;
		label: string;
		count?: number;
		tone?: BadgeTone;
		disabled?: boolean;
	}[];
	"aria-label": string;
	className?: string;
}) {
	return (
		<Tabs
			value={value}
			onValueChange={(next) => {
				if (next) onValueChange(next as Value);
			}}
			className={cn("min-w-0 max-w-full shrink-0", className)}
		>
			<TabsList
				aria-label={ariaLabel}
				className="max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
			>
				{items.map((item) => (
					<TabsTrigger
						key={item.value}
						value={item.value}
						disabled={item.disabled}
					>
						{item.tone ? (
							<span
								className={cn(
									"size-1.5 rounded-full",
									toneDotClassName(item.tone),
								)}
							/>
						) : null}
						{item.label}
						{item.count !== undefined ? (
							<span className="font-normal text-muted-foreground tabular-nums">
								{item.count}
							</span>
						) : null}
					</TabsTrigger>
				))}
			</TabsList>
		</Tabs>
	);
}
