"use client";

import { RotateCcwKeyIcon } from "lucide-react";
import { useState } from "react";
import { FormError, FormSuccess } from "@/components/auth/ui";
import { reauthenticate } from "@/components/sign-out-button";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { FieldGroup } from "@/components/ui/field";
import { authMessage, needsReauth } from "@/lib/auth/errors";

export function SettingsCard({
	title,
	description,
	action,
	footer,
	children,
}: {
	title: string;
	description?: React.ReactNode;
	action?: React.ReactNode;
	footer?: React.ReactNode;
	children?: React.ReactNode;
}) {
	// Flat settings block: a hairline above, heading, controls, footer.
	return (
		<section className="flex flex-col gap-4 border-border border-t pt-8">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0 space-y-1">
					<h2 className="font-semibold text-[15px]">{title}</h2>
					{description && (
						<div className="text-muted-foreground text-sm">{description}</div>
					)}
				</div>
				{action && <div className="shrink-0">{action}</div>}
			</div>
			{children && <div className="flex flex-col gap-4">{children}</div>}
			{footer && <div className="flex flex-wrap gap-2">{footer}</div>}
		</section>
	);
}

export function useAction() {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const [success, setSuccess] = useState<React.ReactNode>(null);
	async function run(action: () => Promise<React.ReactNode | undefined>) {
		setPending(true);
		setError(null);
		setSuccess(null);
		try {
			setSuccess((await action()) ?? null);
			return true;
		} catch (error) {
			setError(error);
			return false;
		} finally {
			setPending(false);
		}
	}
	function reset() {
		setError(null);
		setSuccess(null);
	}
	return { pending, error, success, run, reset };
}

export function ActionFeedback({
	error,
	success,
}: {
	error: unknown;
	success?: React.ReactNode;
}) {
	if (error && needsReauth(error)) {
		return (
			<div role="alert" className="flex flex-col items-start gap-2 text-sm">
				<p>
					For your security, this needs a recent sign-in. Sign in again to
					continue.
				</p>
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => reauthenticate(window.location.pathname)}
				>
					<RotateCcwKeyIcon data-icon="inline-start" />
					Sign in again
				</Button>
			</div>
		);
	}
	return (
		<>
			<FormError>{error ? authMessage(error) : null}</FormError>
			<FormSuccess>{success}</FormSuccess>
		</>
	);
}

export function ActionDialog({
	open,
	onOpenChange,
	title,
	description,
	submitLabel,
	destructive = false,
	pending,
	error,
	onSubmit,
	children,
	footer,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: React.ReactNode;
	submitLabel?: string;
	destructive?: boolean;
	pending: boolean;
	error: unknown;
	onSubmit?: (data: FormData) => void;
	children?: React.ReactNode;
	footer?: React.ReactNode;
}) {
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!pending) onOpenChange(next);
			}}
		>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-md">
				<form
					method="post"
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						onSubmit?.(new FormData(event.currentTarget));
					}}
				>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						{description && (
							<DialogDescription>{description}</DialogDescription>
						)}
					</DialogHeader>
					<FieldGroup>{children}</FieldGroup>
					<ActionFeedback error={error} />
					<DialogFooter>
						{footer ?? (
							<>
								<Button
									type="button"
									variant="outline"
									disabled={pending}
									onClick={() => onOpenChange(false)}
								>
									Cancel
								</Button>
								<Button
									type="submit"
									variant={destructive ? "destructive" : "default"}
									disabled={pending}
								>
									{pending ? "Please wait…" : submitLabel}
								</Button>
							</>
						)}
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export function formatDate(value: Date | string | number) {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}
