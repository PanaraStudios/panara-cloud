"use client";

import { type LucideIcon, SearchIcon, ServerOffIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { DockerMark } from "@/components/icons/server-icons";
import { Button } from "@/components/ui/button";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	type BadgeTone,
	EmptyState,
	toneDotClassName,
} from "@/components/ui-kit/primitives";
import { isActive } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/** Route links under a page header (Logs · Terminal · Inspect), as the same
    pill list every filter on the page uses. */
export function LinkTabs({
	items,
	className,
}: {
	items: { label: string; href: string; exact?: boolean }[];
	className?: string;
}) {
	const pathname = usePathname();
	const current =
		items.find((item) => isActive(pathname, item.href, item.exact))?.href ??
		items[0]?.href;
	return (
		<Tabs value={current} className={className}>
			<TabsList className="max-w-full flex-nowrap overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
				{items.map((item) => (
					<TabsTrigger
						key={item.href}
						value={item.href}
						nativeButton={false}
						render={<Link href={item.href} />}
					>
						{item.label}
					</TabsTrigger>
				))}
			</TabsList>
		</Tabs>
	);
}

/** Mutually exclusive filter: "All 7 · Running 6 · Restarting 1". */
export function FilterPills<Value extends string>({
	value,
	onValueChange,
	options,
}: {
	value: Value;
	onValueChange: (value: Value) => void;
	options: {
		value: Value;
		label: string;
		count?: number;
		tone?: BadgeTone;
		disabled?: boolean;
		title?: string;
	}[];
}) {
	return (
		<Tabs
			value={value}
			onValueChange={(next) => {
				if (next) onValueChange(next as Value);
			}}
			className="min-w-0 max-w-full shrink-0"
		>
			<TabsList className="max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
				{options.map((option) => (
					<TabsTrigger
						key={option.value}
						value={option.value}
						disabled={option.disabled}
						title={option.title}
					>
						{option.tone ? (
							<span
								className={cn(
									"size-1.5 rounded-full",
									toneDotClassName(option.tone),
								)}
							/>
						) : null}
						{option.label}
						{option.count !== undefined ? (
							<span className="font-normal text-muted-foreground tabular-nums">
								{option.count}
							</span>
						) : null}
					</TabsTrigger>
				))}
			</TabsList>
		</Tabs>
	);
}

/** The search box at the start of a list toolbar. Keep the placeholder
    starting with "Search" or "Filter": the app shell's "/" shortcut finds
    it by that. */
export function SearchField({
	value,
	onChange,
	placeholder,
	className,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
	className?: string;
}) {
	return (
		<InputGroup className={cn("w-full sm:w-80", className)}>
			<InputGroupAddon>
				<SearchIcon />
			</InputGroupAddon>
			<InputGroupInput
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
			/>
			<InputGroupAddon align="inline-end">
				<Kbd>/</Kbd>
			</InputGroupAddon>
		</InputGroup>
	);
}

/** Dot + word, coloured word for warning/destructive tones; an optional
    muted note after it ("healthy", "OOM ×3"). */
export function StatusText({
	tone,
	label,
	note,
	hollow,
	className,
}: {
	tone: BadgeTone;
	label: string;
	note?: React.ReactNode;
	/** Hollow ring instead of a dot (Not set up, Queued). */
	hollow?: boolean;
	className?: string;
}) {
	return (
		<span className={cn("inline-flex items-center gap-2 text-sm", className)}>
			<span
				className={cn(
					"size-1.5 shrink-0 rounded-full",
					hollow
						? "border border-muted-foreground bg-transparent"
						: toneDotClassName(tone),
				)}
			/>
			<span
				className={cn(
					tone === "destructive" && "text-destructive",
					tone === "warning" && "text-warning",
					tone === "secondary" && "text-muted-foreground",
				)}
			>
				{label}
			</span>
			{note ? (
				<span className="text-muted-foreground text-xs">{note}</span>
			) : null}
		</span>
	);
}

/** The dark well logs, terminals and setup output render in. */
export function DarkWell({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"overflow-hidden rounded-xl border border-border bg-terminal font-mono text-[13px] text-terminal-foreground/90 leading-6",
				className,
			)}
		>
			{children}
		</div>
	);
}

/** A muted line under a page's main object ("Runs kept for 14 days"). */
export function FootNote({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<p className={cn("text-muted-foreground text-sm", className)}>{children}</p>
	);
}

/** Label/value rows under a `Section` (hairline under each row; the
    section's own rule closes the top). */
export function DetailRows({
	rows,
	labelWidth = "w-40",
}: {
	rows: { label: string; value: React.ReactNode }[];
	labelWidth?: string;
}) {
	return (
		<dl className="flex flex-col">
			{rows.map((row) => (
				<div
					key={row.label}
					className="flex items-start gap-4 border-border border-b py-2.5 text-sm"
				>
					<dt className={cn("shrink-0 text-muted-foreground", labelWidth)}>
						{row.label}
					</dt>
					<dd className="min-w-0 flex-1 break-words">{row.value}</dd>
				</div>
			))}
		</dl>
	);
}

/** A used/total bar under a number. */
export function Meter({
	percent,
	tone,
	className,
}: {
	percent: number | null;
	tone?: "warning";
	className?: string;
}) {
	return (
		<div
			className={cn(
				"h-1 w-full overflow-hidden rounded-full bg-muted",
				className,
			)}
		>
			<div
				className={cn(
					"h-full rounded-full transition-[width]",
					tone === "warning" ? "bg-warning" : "bg-foreground",
				)}
				style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }}
			/>
		</div>
	);
}

/** A big-number `StatStrip` cell with a glyph before its label (the kit's
    `StatCell` takes a plain string label). */
export function IconStat({
	icon: Icon,
	label,
	className,
	children,
}: {
	icon: LucideIcon;
	label: string;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div className={cn("flex min-w-0 flex-col gap-1 px-4 py-3", className)}>
			<span className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
				<Icon aria-hidden="true" className="size-3.5 shrink-0" />
				<span className="truncate">{label}</span>
			</span>
			<span className="flex min-w-0 items-baseline gap-1.5 font-semibold text-xl tabular-nums">
				{children}
			</span>
		</div>
	);
}

/** A heading's text with its glyph, for section titles the kit's `Section`
    doesn't render (form pages, settings blocks). */
export function IconTitle({
	icon: Icon,
	children,
}: {
	icon: LucideIcon;
	children: React.ReactNode;
}) {
	return (
		<span className="flex items-center gap-2">
			<Icon
				aria-hidden="true"
				className="size-4 shrink-0 text-muted-foreground"
			/>
			{children}
		</span>
	);
}

/** One label/value row of an overview `Section`. */
export function SectionRow({
	label,
	children,
	className,
}: {
	label: React.ReactNode;
	children?: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex min-h-11 items-center justify-between gap-4 border-border border-b py-2 text-sm",
				className,
			)}
		>
			<span className="min-w-0 truncate">{label}</span>
			<span className="min-w-0 shrink-0 text-right text-muted-foreground">
				{children}
			</span>
		</div>
	);
}

/** The one sentence an empty or loading section shows instead of a box. */
export function SectionNote({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<p className={cn("py-3 text-muted-foreground text-sm", className)}>
			{children}
		</p>
	);
}

const DOCKER_DOWN = /docker\.sock|docker daemon|Cannot connect to the Docker/i;
const SERVER_DOWN =
	/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|did not answer|timed? ?out|handshake/i;

/** A plain sentence for a failed read, and the raw message worth showing
    small under it. */
export function describeFailure(error: string, what: string) {
	// Convex wraps a thrown error as "[CONVEX A(fn)] [Request ID: x] Server
	// Error\nUncaught ConvexError: <message> at handler ..."; keep the message.
	const raw =
		error
			.replace(
				/^\[CONVEX [^\]]+\]\s*(\[Request ID: [^\]]+\]\s*)?(Server Error\s*)?/,
				"",
			)
			.replace(/^Uncaught \w*Error:\s*/, "")
			.replace(/\s+at (async )?handler[\s\S]*$/, "")
			.split("\n")[0]
			?.trim() ?? "";
	const cause = DOCKER_DOWN.test(error)
		? ("docker" as const)
		: SERVER_DOWN.test(error)
			? ("server" as const)
			: ("other" as const);
	return {
		cause,
		sentence:
			cause === "docker"
				? "Couldn't reach Docker on this server."
				: cause === "server"
					? "This server didn't answer."
					: `Couldn't load ${what}.`,
		raw: raw.length > 200 ? `${raw.slice(0, 200)}…` : raw,
	};
}

/** A failed read inside a section: the sentence, the raw line small under
    it, and a way to try again. */
export function FailureNote({
	error,
	what,
	onRetry,
	retrying,
	className,
}: {
	error: string;
	what: string;
	onRetry?: () => void;
	retrying?: boolean;
	className?: string;
}) {
	const { sentence, raw } = describeFailure(error, what);
	return (
		<div
			className={cn(
				"flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3",
				className,
			)}
		>
			<div className="min-w-0">
				<p className="text-muted-foreground text-sm">{sentence}</p>
				{raw ? (
					<p className="break-all font-mono text-[12px] text-muted-foreground">
						{raw}
					</p>
				) : null}
			</div>
			{onRetry ? (
				<Button
					variant="outline"
					size="sm"
					isLoading={retrying}
					onClick={onRetry}
				>
					Try again
				</Button>
			) : null}
		</div>
	);
}

/** A whole list that couldn't be read (Docker down, agent silent). */
export function LoadFailed({
	icon,
	what,
	error,
	onRetry,
	retrying,
}: {
	icon: LucideIcon;
	what: string;
	error: string;
	onRetry?: () => void;
	retrying?: boolean;
}) {
	const { cause, sentence, raw } = describeFailure(error, what);
	return (
		<EmptyState
			icon={
				cause === "docker"
					? DockerMark
					: cause === "server"
						? ServerOffIcon
						: icon
			}
			title={sentence.replace(/\.$/, "")}
			description={`${what.charAt(0).toUpperCase()}${what.slice(1)} show up here once the server answers.`}
		>
			{raw ? (
				<p className="w-[min(40rem,80vw)] shrink-0 break-words font-mono text-[12px] text-muted-foreground">
					{raw}
				</p>
			) : null}
			{onRetry ? (
				<Button
					variant="outline"
					size="sm"
					isLoading={retrying}
					onClick={onRetry}
				>
					Try again
				</Button>
			) : null}
		</EmptyState>
	);
}

/** The shape of a list while its first read is on the way. */
export function ListSkeleton({ rows = 5 }: { rows?: number }) {
	return (
		<div
			role="status"
			aria-label="Loading"
			className="overflow-hidden rounded-xl border border-border"
		>
			<div className="flex h-9 items-center border-border border-b px-4">
				<Skeleton className="h-3 w-24" />
			</div>
			{Array.from({ length: rows }, (_, index) => (
				<div
					// A fixed run of placeholders; position is their identity.
					key={index}
					className="flex h-12 items-center gap-6 border-border border-b px-4 last:border-b-0"
				>
					<Skeleton className="h-3 w-48" />
					<Skeleton className="h-3 w-20" />
					<Skeleton className="ml-auto h-3 w-16" />
				</div>
			))}
		</div>
	);
}

/** The one notice a page shows when something it depends on is down:
    a hairline row with a state dot, never a tinted panel. */
export function Notice({
	tone = "warning",
	title,
	children,
	action,
}: {
	tone?: BadgeTone;
	title: string;
	children?: React.ReactNode;
	action?: React.ReactNode;
}) {
	return (
		<div
			role="status"
			className="flex flex-col gap-3 rounded-xl border border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
		>
			<div className="flex min-w-0 gap-3">
				<span
					className={cn(
						"mt-2 size-1.5 shrink-0 rounded-full",
						toneDotClassName(tone),
					)}
				/>
				<div className="min-w-0 space-y-0.5">
					<p className="font-medium text-sm">{title}</p>
					{children ? (
						<div className="text-muted-foreground text-sm">{children}</div>
					) : null}
				</div>
			</div>
			{action ? (
				<div className="flex shrink-0 flex-wrap items-center gap-2 pl-[18px] sm:pl-0">
					{action}
				</div>
			) : null}
		</div>
	);
}
