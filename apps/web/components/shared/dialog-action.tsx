"use client";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogClose,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { rendersNativeButton, triggerRole } from "@/lib/native-button";

interface Props {
	title?: string | React.ReactNode;
	description?: string | React.ReactNode;
	onClick: () => void;
	children?: React.ReactNode;
	disabled?: boolean;
	type?: "default" | "destructive";
	confirmLabel?: string;
}

export const DialogAction = ({
	onClick,
	children,
	description,
	title,
	disabled,
	type,
	confirmLabel = "Confirm",
}: Props) => {
	return (
		<AlertDialog>
			<AlertDialogTrigger
				render={children as React.ReactElement}
				nativeButton={rendersNativeButton(children)}
				role={triggerRole(children)}
			/>
			<AlertDialogContent className="data-[size=default]:max-w-lg data-[size=default]:sm:max-w-lg">
				<AlertDialogHeader>
					<AlertDialogTitle>
						{title ?? "Are you absolutely sure?"}
					</AlertDialogTitle>
					{/* A description made of paragraphs can't sit in the <p> a plain
					    one is. */}
					<AlertDialogDescription
						render={
							description === undefined || typeof description === "string" ? (
								<p />
							) : (
								<div />
							)
						}
					>
						{description ?? "This action cannot be undone."}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogClose
						render={
							<AlertDialogAction
								disabled={disabled}
								onClick={onClick}
								variant={type ?? "destructive"}
							/>
						}
					>
						{confirmLabel}
					</AlertDialogClose>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
};
