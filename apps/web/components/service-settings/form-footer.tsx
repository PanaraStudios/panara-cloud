"use client";

import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";

/** A form's submit row: the dialog footer, or a save bar pinned to the
    bottom of the viewport when the same form is a page. On a page `status`
    says where the form stands (unsaved, waiting for a deploy) at the start
    of the bar. */
export function FormFooter({
	page,
	onCancel,
	status,
	children,
}: {
	page: boolean;
	onCancel?: () => void;
	status?: React.ReactNode;
	children: React.ReactNode;
}) {
	if (!page) return <DialogFooter>{children}</DialogFooter>;
	return (
		<div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-x-4 gap-y-2 border-border border-t bg-background py-3">
			{status ? (
				<div className="flex min-w-0 flex-1 basis-40 flex-wrap items-center gap-x-3 gap-y-1.5">
					{status}
				</div>
			) : null}
			<div className="flex shrink-0 items-center gap-2">
				{onCancel ? (
					<Button type="button" variant="ghost" onClick={onCancel}>
						Cancel
					</Button>
				) : null}
				{children}
			</div>
		</div>
	);
}
