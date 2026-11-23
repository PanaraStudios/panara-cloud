/** A failure in plain words; the raw message is a small mono line under it. */
export function QuietError({
	message,
	detail,
}: {
	message: string;
	detail?: string | null;
}) {
	return (
		<div role="alert" className="flex flex-col gap-1 py-3">
			<p className="text-muted-foreground text-sm">{message}</p>
			{detail ? (
				<p className="break-words font-mono text-[12px] text-muted-foreground">
					{detail}
				</p>
			) : null}
		</div>
	);
}
