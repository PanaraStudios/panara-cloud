"use client";

import { CheckIcon, ChevronsUpDownIcon, PlusIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	type AutoDeployMode,
	type AutoDeploySource,
	addWatchPath,
	autoDeployHint,
	autoDeployLabel,
} from "@/lib/service-source";
import { cn } from "@/lib/utils";

/** One field of a source form: label, control, then one quiet line (or what
    is wrong with the value). `aside` sits at the end of the label row. */
export function SourceField({
	label,
	htmlFor,
	hint,
	error,
	aside,
	className,
	children,
}: {
	label: string;
	htmlFor?: string;
	hint?: React.ReactNode;
	error?: string | null;
	aside?: React.ReactNode;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div className={cn("flex min-w-0 flex-col gap-2", className)}>
			<div className="flex min-h-5 items-center justify-between gap-3">
				<Label htmlFor={htmlFor}>{label}</Label>
				{aside}
			</div>
			{children}
			{error ? (
				<p role="alert" className="text-[13px] text-destructive">
					{error}
				</p>
			) : hint ? (
				<p className="text-[13px] text-muted-foreground">{hint}</p>
			) : null}
		</div>
	);
}

export type PickerOption = {
	key: string;
	label: string;
	/** Shown muted after the label (a repository's owner). */
	detail?: string;
	/** What the search matches, when it is more than the label. */
	search?: string;
};

/** A searchable list behind a button, as wide as the button and opening
    under it: repositories, branches. */
export function SearchPicker({
	id,
	value,
	selected,
	placeholder,
	searchPlaceholder,
	options,
	loading,
	empty,
	blocked,
	invalid,
	disabled,
	onSelect,
}: {
	id?: string;
	/** What the button shows; empty shows the placeholder. */
	value: string;
	/** The chosen option's key, for the check mark. */
	selected?: string;
	placeholder: string;
	searchPlaceholder: string;
	options: readonly PickerOption[] | undefined;
	loading?: boolean;
	empty: string;
	/** Why there is nothing to pick yet ("Choose an account first"). */
	blocked?: string | null;
	invalid?: boolean;
	disabled?: boolean;
	onSelect: (key: string) => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button
						id={id}
						variant="outline"
						autoIcon={false}
						aria-invalid={invalid || undefined}
						disabled={disabled}
						className={cn(
							"h-control w-full justify-between bg-field px-2.5 font-normal",
							!value && "text-faint-foreground",
						)}
					/>
				}
			>
				<span className="min-w-0 truncate">
					{loading && !value ? "Loading…" : value || placeholder}
				</span>
				<ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" />
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-(--anchor-width) min-w-64 gap-0 p-0"
			>
				<Command>
					<CommandInput placeholder={searchPlaceholder} className="h-9" />
					<CommandList className="max-h-80">
						{blocked ? (
							<p className="px-3 py-6 text-center text-muted-foreground text-sm">
								{blocked}
							</p>
						) : loading ? (
							<p className="px-3 py-6 text-center text-muted-foreground text-sm">
								Loading…
							</p>
						) : (
							<>
								<CommandEmpty>{empty}</CommandEmpty>
								<CommandGroup>
									{options?.map((option) => (
										<CommandItem
											key={option.key}
											value={option.search ?? option.label}
											onSelect={() => {
												onSelect(option.key);
												setOpen(false);
											}}
										>
											<span className="flex min-w-0 items-center gap-2">
												<span className="truncate">{option.label}</span>
												{option.detail ? (
													<span className="shrink-0 text-muted-foreground text-xs">
														{option.detail}
													</span>
												) : null}
											</span>
											<CheckIcon
												className={cn(
													"ml-auto size-4",
													option.key === selected ? "opacity-100" : "opacity-0",
												)}
											/>
										</CommandItem>
									))}
								</CommandGroup>
							</>
						)}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

/** Globs a push must touch to deploy: the list, then one input that adds to
    it on Enter or with its button. */
export function WatchPathsField({
	value,
	onChange,
	hint,
	disabled,
	className,
}: {
	value: readonly string[];
	onChange: (paths: string[]) => void;
	hint: string;
	disabled?: boolean;
	className?: string;
}) {
	const id = useId();
	const [input, setInput] = useState("");
	const add = () => {
		onChange(addWatchPath(value, input));
		setInput("");
	};
	return (
		<SourceField
			label="Watch paths"
			htmlFor={id}
			hint={hint}
			className={className}
		>
			{value.length > 0 ? (
				<ul className="flex flex-wrap gap-1.5">
					{value.map((path) => (
						<li
							key={path}
							className="inline-flex h-6 items-center gap-1 rounded-md bg-muted pr-1 pl-2 font-mono text-[13px]"
						>
							{path}
							<button
								type="button"
								disabled={disabled}
								aria-label={`Remove ${path}`}
								className="inline-flex size-4 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
								onClick={() => onChange(value.filter((item) => item !== path))}
							>
								<XIcon className="size-3" />
							</button>
						</li>
					))}
				</ul>
			) : null}
			<div className="flex gap-2">
				<Input
					id={id}
					value={input}
					disabled={disabled}
					placeholder="src/**, dist/*.js"
					className="font-mono text-[13px]"
					onChange={(event) => setInput(event.target.value)}
					onKeyDown={(event) => {
						if (event.key !== "Enter") return;
						event.preventDefault();
						add();
					}}
				/>
				<Button
					type="button"
					variant="outline"
					size="lg"
					disabled={disabled}
					disabledReason={
						disabled || input.trim() ? undefined : "Type a path first"
					}
					onClick={add}
				>
					<PlusIcon data-icon="inline-start" />
					Add
				</Button>
			</div>
		</SourceField>
	);
}

/** Switches of a form, one under the other with a hairline between them. */
export function SwitchRows({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex flex-col divide-y divide-border border-border border-t">
			{children}
		</div>
	);
}

/** When the service deploys by itself: one choice, then one line about the
    chosen one. */
export function AutomaticDeploysField({
	source,
	mode,
	modes,
	onChange,
	disabled,
}: {
	source: AutoDeploySource;
	mode: AutoDeployMode;
	modes: readonly AutoDeployMode[];
	onChange: (mode: AutoDeployMode) => void;
	disabled?: boolean;
}) {
	const id = useId();
	return (
		<SourceField
			label="Automatic deploys"
			htmlFor={id}
			hint={autoDeployHint(mode, source)}
		>
			<Select
				value={mode}
				disabled={disabled}
				onValueChange={(next) => onChange(next as AutoDeployMode)}
			>
				<SelectTrigger id={id} className="w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{modes.map((item) => (
						<SelectItem key={item} value={item}>
							{autoDeployLabel(item, source)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</SourceField>
	);
}
