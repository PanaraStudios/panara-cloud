"use client";

import copy from "copy-to-clipboard";
import { Clipboard } from "lucide-react";
import { useRef } from "react";
import { toast } from "sonner";
import { Button } from "../ui/button";
import { Input, type InputProps } from "../ui/input";

export const ToggleVisibilityInput = ({ ...props }: InputProps) => {
	const inputRef = useRef<HTMLInputElement>(null);

	return (
		<div className="flex w-full items-center space-x-2">
			<Input ref={inputRef} {...props} type="password" />
			<Button
				type="button"
				variant="outline"
				size="icon"
				aria-label="Copy value"
				onClick={() => {
					copy(inputRef.current?.value || "");
					toast.success("Copied");
				}}
			>
				<Clipboard className="text-muted-foreground" />
			</Button>
			{/* <Button onClick={togglePasswordVisibility} variant={"secondary"}>
				{isPasswordVisible ? (
					<EyeOffIcon className="size-4 text-muted-foreground" />
				) : (
					<EyeIcon className="size-4 text-muted-foreground" />
				)}
			</Button> */}
		</div>
	);
};
