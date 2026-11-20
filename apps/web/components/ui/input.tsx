"use client";

import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "cn";
import copy from "copy-to-clipboard";
import {
	ClipboardIcon,
	EyeIcon,
	EyeOffIcon,
	RefreshCcwIcon,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	InputValidation,
	type InputValidationProps,
} from "@/components/ui/inline-toast";
import { credentialInputProps } from "@/lib/credential-input";
import { generateRandomPassword } from "@/lib/password-utils";

/* opensend's Input: surface fill, 1px border, 8px radius, 36px tall, 14px text.
   Focus swaps the border to accent and adds a soft 2px accent ring.
   Panara Cloud keeps the extras its screens rely on: the reveal / generate
   buttons on password fields, a copy button and an inline error message. */
const inputClassName =
	"h-control w-full min-w-0 rounded-lg border border-input bg-field px-2.5 py-1 text-base text-foreground shadow-none transition-[border-color,box-shadow] outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-faint-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 disabled:shadow-none aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 md:text-sm";

export interface InputProps
	extends React.ComponentProps<"input">,
		InputValidationProps {
	credential?: boolean;
	errorMessage?: string;
	enablePasswordGenerator?: boolean;
	passwordGeneratorLength?: number;
	enableCopyButton?: boolean;
}

function Input({
	className,
	type,
	credential = false,
	validationMessage,
	validationMessages,
	onValidationClear,
	errorMessage,
	enablePasswordGenerator = false,
	passwordGeneratorLength,
	enableCopyButton = false,
	ref,
	...props
}: InputProps) {
	const [showPassword, setShowPassword] = React.useState(false);
	const inputRef = React.useRef<HTMLInputElement | null>(null);
	// Inside an InputGroup the group's addons own the reveal/copy controls.
	const inGroup =
		(props as { "data-slot"?: string })["data-slot"] === "input-group-control";
	const isPassword = type === "password" && !inGroup;
	const shouldShowGenerator =
		isPassword && enablePasswordGenerator && !props.disabled && !props.readOnly;
	const inputType = isPassword ? (showPassword ? "text" : "password") : type;

	const setRefs = React.useCallback(
		(node: HTMLInputElement | null) => {
			inputRef.current = node;
			if (typeof ref === "function") {
				ref(node);
			} else if (ref && typeof ref === "object") {
				(ref as { current: HTMLInputElement | null }).current = node;
			}
		},
		[ref],
	);

	const handleGeneratePassword = () => {
		const nextValue =
			typeof passwordGeneratorLength === "number" && passwordGeneratorLength > 0
				? generateRandomPassword(Math.floor(passwordGeneratorLength))
				: generateRandomPassword();
		const input = inputRef.current;
		if (!input) return;
		const valueSetter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		if (valueSetter) {
			valueSetter.call(input, nextValue);
		} else {
			input.value = nextValue;
		}
		input.dispatchEvent(new Event("input", { bubbles: true }));
	};

	const handleCopy = () => {
		copy(inputRef.current?.value || "");
		toast.success("Copied");
	};

	const control = (
		<InputValidation
			validationMessage={validationMessage}
			validationMessages={validationMessages}
			onValidationClear={onValidationClear}
		>
			<InputPrimitive
				type={inputType}
				data-slot="input"
				className={cn(
					inputClassName,
					isPassword && (shouldShowGenerator ? "pr-16" : "pr-10"),
					className,
				)}
				ref={setRefs}
				{...props}
				name={
					props.name ??
					(credential && type === "password" ? "service-secret" : undefined)
				}
				{...(credential ? credentialInputProps(type === "password") : {})}
			/>
		</InputValidation>
	);

	const inputElement = isPassword ? (
		<div className="relative w-full">
			{control}
			<div className="absolute inset-y-0 right-0 flex items-center gap-1 pr-3 text-muted-foreground">
				{shouldShowGenerator && (
					<button
						type="button"
						className="hover:text-foreground focus:outline-none"
						onClick={handleGeneratePassword}
						aria-label="Generate password"
						title="Generate password"
						tabIndex={-1}
					>
						<RefreshCcwIcon className="size-4" />
					</button>
				)}
				<button
					type="button"
					className="hover:text-foreground focus:outline-none"
					onClick={() => setShowPassword(!showPassword)}
					aria-label={showPassword ? "Hide value" : "Show value"}
					tabIndex={-1}
				>
					{showPassword ? (
						<EyeOffIcon className="size-4" />
					) : (
						<EyeIcon className="size-4" />
					)}
				</button>
			</div>
		</div>
	) : (
		control
	);

	return (
		<>
			{enableCopyButton ? (
				<div className="flex w-full items-center gap-2">
					{inputElement}
					<Button
						type="button"
						variant="outline"
						size="icon"
						onClick={handleCopy}
						aria-label="Copy value"
					>
						<ClipboardIcon className="text-muted-foreground" />
					</Button>
				</div>
			) : (
				inputElement
			)}
			{errorMessage && (
				<span className="text-sm text-destructive">{errorMessage}</span>
			)}
		</>
	);
}

/** Integer field: hands react-hook-form a number instead of the input's string. */
function NumberInput({ className, ref, ...props }: InputProps) {
	return (
		<Input
			type="text"
			className={cn("text-left", className)}
			ref={ref}
			{...props}
			value={props.value === undefined ? undefined : String(props.value)}
			onChange={(e) => {
				const value = e.target.value;
				if (value === "") {
					props.onChange?.(e);
				} else {
					const number = Number.parseInt(value, 10);
					if (!Number.isNaN(number)) {
						const syntheticEvent = {
							...e,
							target: {
								...e.target,
								value: number,
							},
						};
						props.onChange?.(
							syntheticEvent as unknown as React.ChangeEvent<HTMLInputElement>,
						);
					}
				}
			}}
		/>
	);
}

export { Input, inputClassName, NumberInput };
