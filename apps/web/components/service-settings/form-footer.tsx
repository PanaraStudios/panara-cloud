"use client";

import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";

/** A form's submit row: the dialog footer, or a save bar pinned to the
    bottom of the viewport when the same form is a page. */
export function FormFooter({
	page,
	onCancel,
	children,
}: {
	page: boolean;
	onCancel?: () => void;
	children: React.ReactNode;
}) {
	if (!page) return <DialogFooter>{children}</DialogFooter>;
	return (
		<div className="sticky bottom-0 z-10 flex items-center justify-end gap-2 border-border border-t bg-background py-3">
			{onCancel ? (
				<Button type="button" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
			) : null}
			{children}
		</div>
	);
}
