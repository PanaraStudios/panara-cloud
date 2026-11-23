import { cn } from "@/lib/utils";

interface Props {
	type: string;
	className?: string;
}

export const DnsRecordTypeBadge = ({ type, className }: Props) => (
	<span
		className={cn(
			"inline-flex h-6 min-w-14 shrink-0 items-center justify-center rounded-md border border-border px-2 font-mono text-[12px] text-foreground",
			className,
		)}
	>
		{type.toUpperCase()}
	</span>
);
