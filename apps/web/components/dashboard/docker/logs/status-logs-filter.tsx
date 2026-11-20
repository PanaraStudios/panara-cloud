"use client";

import { CheckIcon } from "lucide-react";
import type React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandGroup,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

interface StatusLogsFilterProps {
	value?: string[];
	setValue?: (value: string[]) => void;
	title?: string;
	options: {
		label: string;
		value: string;
		icon?: React.ComponentType<{ className?: string }>;
	}[];
}

export function StatusLogsFilter({
	value = [],
	setValue,
	title,
	options,
}: StatusLogsFilterProps) {
	const selectedValues = new Set(value as string[]);
	const allSelected = selectedValues.size === 0;

	const getSelectedBadges = () => {
		if (allSelected) {
			return (
				<Badge variant="secondary" className="rounded-sm px-1 font-normal">
					All
				</Badge>
			);
		}

		if (selectedValues.size >= 1) {
			const selected = options.find((opt) => selectedValues.has(opt.value));
			return (
				<>
					<Badge
						variant={
							selected?.value === "success"
								? "success"
								: selected?.value === "error"
									? "destructive"
									: selected?.value === "warning"
										? "warning"
										: selected?.value === "info"
											? "info"
											: selected?.value === "debug"
												? "warning"
												: "secondary"
						}
						className="rounded-sm px-1 font-normal"
					>
						{selected?.label}
					</Badge>
					{selectedValues.size > 1 && (
						<Badge variant="secondary" className="rounded-sm px-1 font-normal">
							+{selectedValues.size - 1}
						</Badge>
					)}
				</>
			);
		}

		return null;
	};

	return (
		<Popover>
			<PopoverTrigger
				render={
					<Button
						variant="outline"
						size="sm"
						className="h-9 bg-input text-sm placeholder-gray-400 w-full sm:w-auto"
					/>
				}
			>
				{title}
				<Separator orientation="vertical" className="mx-2 h-4" />
				<div className="space-x-1 flex">{getSelectedBadges()}</div>
			</PopoverTrigger>
			<PopoverContent className="w-[200px] p-0" align="start">
				<Command>
					<CommandList>
						<CommandGroup>
							<CommandItem
								onSelect={() => {
									setValue?.([]); // Empty array means "All"
								}}
							>
								<div
									className={cn(
										"mr-2 flex h-4 w-4 items-center rounded-sm border border-primary",
										allSelected
											? "bg-primary text-primary-foreground"
											: "opacity-50 [&_svg]:invisible",
									)}
								>
									<CheckIcon className={cn("h-4 w-4")} />
								</div>
								<Badge variant="secondary">All</Badge>
							</CommandItem>
							{options.map((option) => {
								const isSelected = selectedValues.has(option.value);
								return (
									<CommandItem
										key={option.value}
										onSelect={() => {
											const newValues = new Set(selectedValues);
											if (isSelected) {
												newValues.delete(option.value);
											} else {
												newValues.add(option.value);
											}
											setValue?.(Array.from(newValues));
										}}
									>
										<div
											className={cn(
												"mr-2 flex h-4 w-4 items-center rounded-sm border border-primary",
												isSelected
													? "bg-primary text-primary-foreground"
													: "opacity-50 [&_svg]:invisible",
											)}
										>
											<CheckIcon className={cn("h-4 w-4")} />
										</div>
										{option.icon && (
											<option.icon className="mr-2 h-4 w-4 text-muted-foreground" />
										)}
										<Badge
											variant={
												option.value === "success"
													? "success"
													: option.value === "error"
														? "destructive"
														: option.value === "warning"
															? "warning"
															: option.value === "info"
																? "info"
																: option.value === "debug"
																	? "warning"
																	: "secondary"
											}
										>
											{option.label}
										</Badge>
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
