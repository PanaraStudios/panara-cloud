"use client";

import Link from "next/link";
import { createContext, useContext } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// One form, two hosts: a dialog (inline edits from a list) or a focused page
// (the owner rule: more than three fields gets its own URL). The Handle*
// forms use these in place of the Dialog parts.
const PageMode = createContext(false);

export const useFormShellPage = () => useContext(PageMode);

export function FormShell({
	asPage = false,
	open,
	onOpenChange,
	back,
	pageTitle,
	pageDescription,
	children,
}: {
	asPage?: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	back: { href: string; label: string };
	pageTitle: string;
	pageDescription?: React.ReactNode;
	children: React.ReactNode;
}) {
	if (asPage) {
		return (
			<PageMode.Provider value>
				<div className="flex w-full max-w-3xl flex-col gap-6 pb-10">
					<div className="space-y-1">
						<p className="text-muted-foreground text-sm">
							<Link href={back.href} className="hover:text-foreground">
								{back.label}
							</Link>{" "}
							/
						</p>
						<h1 className="text-h3">{pageTitle}</h1>
						{pageDescription ? (
							<p className="max-w-2xl text-muted-foreground text-sm">
								{pageDescription}
							</p>
						) : null}
					</div>
					{children}
				</div>
			</PageMode.Provider>
		);
	}
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{children}
		</Dialog>
	);
}

export function FormShellTrigger(
	props: React.ComponentProps<typeof DialogTrigger>,
) {
	if (useFormShellPage()) return null;
	return <DialogTrigger {...props} />;
}

export function FormShellContent({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	if (useFormShellPage()) {
		return <div className="flex flex-col gap-4">{children}</div>;
	}
	return <DialogContent className={className}>{children}</DialogContent>;
}

/** The dialog's title block; a page shows its own heading instead. */
export function FormShellHeader({
	title,
	description,
}: {
	title: React.ReactNode;
	description?: React.ReactNode;
}) {
	if (useFormShellPage()) return null;
	return (
		<DialogHeader>
			<DialogTitle>{title}</DialogTitle>
			{description ? (
				<DialogDescription>{description}</DialogDescription>
			) : null}
		</DialogHeader>
	);
}

export function FormShellFooter({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	if (useFormShellPage()) {
		return (
			<div
				className={cn(
					"flex flex-wrap items-center justify-end gap-2 border-t pt-4",
					className,
				)}
			>
				{children}
			</div>
		);
	}
	return <DialogFooter className={className}>{children}</DialogFooter>;
}
