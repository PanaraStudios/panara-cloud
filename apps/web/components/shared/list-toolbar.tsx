"use client";

import { SearchIcon } from "lucide-react";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

export function Toolbar({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex flex-wrap items-center gap-2", className)}>
			{children}
		</div>
	);
}

/** A list's search box. Keep the placeholder starting with "Search" or
    "Filter": the app shell's "/" shortcut finds it by that. */
export function ToolbarSearch({
	value,
	onChange,
	placeholder,
	autoFocus,
	className,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
	autoFocus?: boolean;
	className?: string;
}) {
	return (
		<InputGroup className={cn("w-full sm:w-80", className)}>
			<InputGroupAddon>
				<SearchIcon />
			</InputGroupAddon>
			<InputGroupInput
				autoFocus={autoFocus}
				placeholder={placeholder}
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
			<InputGroupAddon align="inline-end">
				<Kbd>/</Kbd>
			</InputGroupAddon>
		</InputGroup>
	);
}
