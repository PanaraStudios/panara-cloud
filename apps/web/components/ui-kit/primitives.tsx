"use client";

/* Page-level building blocks from opensend.cc's dashboard
   (components/dashboard/primitives.tsx), for the redesigned Panara Cloud
   pages. Only the product-neutral ones are here; opensend's email, channel
   and pagination helpers stay in opensend. The dashboard screens use
   PageHeader/SectionHeader for their page chrome. */

import {
	ArrowLeftIcon,
	CheckIcon,
	CopyIcon,
	EyeIcon,
	EyeOffIcon,
	InfoIcon,
	type LucideIcon,
	MoreHorizontalIcon,
	XIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardFooter,
	CardFrame,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import {
	Field,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@/components/ui/input-group";
import {
	Item,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from "@/components/ui/item";
import { Kbd } from "@/components/ui/kbd";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import {
	Table,
	TableBody,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/auth/errors";
import {
	ShortcutAction,
	useConfirmShortcut,
	useShortcut,
	useShortcutModifier,
} from "@/lib/dashboard/use-shortcut";
import { cn } from "@/lib/utils";

/** Status tones a badge, a dot or a chart stroke can take. */
export type BadgeTone =
	| "success"
	| "destructive"
	| "warning"
	| "info"
	| "secondary"
	| "outline";

function sentenceCase(value: string) {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

/* ------------------------------------------------------------------ layout */

/* A dashboard screen can be a page of its own or sit under the header and
   tabs of a service, a server, a project or the account. Inside `NestedPage`
   its PageHeader renders as a section heading, so a page keeps one h1. */
const NestedPageContext = React.createContext(false);

export function NestedPage({ children }: { children: React.ReactNode }) {
	return <NestedPageContext value={true}>{children}</NestedPageContext>;
}

export function PageHeader({
	title,
	description,
	children,
}: {
	title: string;
	description?: React.ReactNode;
	children?: React.ReactNode;
}) {
	const nested = React.useContext(NestedPageContext);
	if (nested) return <SectionHeader {...{ title, description, children }} />;
	return (
		<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
			<div className="min-w-0 space-y-1">
				<h1 className="text-h3 text-foreground">{title}</h1>
				{description ? (
					<p className="max-w-2xl text-small text-muted-foreground">
						{description}
					</p>
				) : null}
			</div>
			{children ? (
				<div className="flex shrink-0 flex-wrap items-center gap-2">
					<ShortcutAction value="create">{children}</ShortcutAction>
				</div>
			) : null}
		</div>
	);
}

/** A titled section under the page header: h2, muted line, actions. */
export function SectionHeader({
	title,
	description,
	children,
}: {
	title: string;
	description?: React.ReactNode;
	children?: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
			<div className="min-w-0 space-y-1 sm:max-w-[60%] sm:shrink-0">
				<h2 className="font-semibold text-base">{title}</h2>
				{description ? (
					<p className="max-w-2xl text-small text-muted-foreground">
						{description}
					</p>
				) : null}
			</div>
			{children ? (
				<div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
					{children}
				</div>
			) : null}
		</div>
	);
}

/** A page section whose rows hang off one hairline: title (with a muted
    hint), an action on the right, then the content. Use it for every block
    on an overview page, so sections line up the same way everywhere. */
export function Section({
	title,
	icon: Icon,
	hint,
	actions,
	className,
	children,
}: {
	title: string;
	/** A small glyph before the title, to recognise the section at a glance. */
	icon?: LucideIcon;
	hint?: React.ReactNode;
	actions?: React.ReactNode;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<section className={cn("flex min-w-0 flex-col", className)}>
			<div className="flex min-h-10 items-center gap-2 border-border border-b pb-2 max-sm:flex-wrap">
				<h2 className="flex min-w-0 flex-1 items-center gap-2 truncate font-semibold text-[15px] max-sm:min-w-[40%]">
					{Icon ? (
						<Icon className="size-4 shrink-0 text-muted-foreground" />
					) : null}
					{title}
					{hint ? (
						<span className="font-normal text-muted-foreground text-sm">
							{hint}
						</span>
					) : null}
				</h2>
				{actions}
			</div>
			{children}
		</section>
	);
}

/** The strip of key facts under a detail header: one hairline box, cells
    split by hairlines, two per row on small screens. */
export function StatStrip({
	className,
	children,
}: {
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div
			className={cn(
				"grid grid-cols-2 overflow-hidden rounded-xl border border-border lg:auto-cols-fr lg:grid-flow-col lg:grid-cols-none [&>*]:border-border max-lg:[&>*:nth-child(even)]:border-l max-lg:[&>*:last-child:nth-child(odd)]:col-span-2 max-lg:[&>*:nth-child(n+3)]:border-t lg:[&>*+*]:border-l",
				className,
			)}
		>
			{children}
		</div>
	);
}

/** One fact in a `StatStrip`: a muted label over its value. `big` is for a
    number that is the point of the cell (CPU 12%). */
export function StatCell({
	label,
	big = false,
	footer,
	className,
	children,
}: {
	label: string;
	big?: boolean;
	/** A meter or a note under the value. */
	footer?: React.ReactNode;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div className={cn("flex min-w-0 flex-col gap-1 px-4 py-3", className)}>
			<span className="truncate text-caption text-muted-foreground">
				{label}
			</span>
			<span
				className={cn(
					"flex min-w-0 items-baseline gap-1.5",
					big
						? "font-semibold text-xl tabular-nums"
						: "truncate font-medium text-sm",
				)}
			>
				{children}
			</span>
			{footer}
		</div>
	);
}

/** Local draft of a stored string: edits stay here until `commitDraft`, and
    a change to the stored value from elsewhere replaces the draft. */
export function useDraftValue(value: string, commit: (next: string) => void) {
	const [draft, setDraft] = React.useState(value);
	const [synced, setSynced] = React.useState(value);
	if (synced !== value) {
		setSynced(value);
		setDraft(value);
	}
	return {
		draft,
		setDraft,
		commitDraft: () => {
			if (draft !== value) commit(draft);
		},
	};
}

/** Local draft for a stored text field. Commits on blur. */
export function useDraft(
	value: string,
	commit: (next: string) => void,
	onChange?: () => void,
) {
	const { draft, setDraft, commitDraft } = useDraftValue(value, commit);
	return {
		value: draft,
		onChange: (
			event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
		) => {
			setDraft(event.target.value);
			onChange?.();
		},
		onBlur: commitDraft,
	};
}

export function DetailHeader({
	backHref,
	backLabel,
	title,
	icon: Icon,
	description,
	badge,
	actions,
}: {
	backHref: string;
	backLabel: string;
	title: string;
	icon?: LucideIcon;
	description?: string;
	badge?: React.ReactNode;
	actions?: React.ReactNode;
}) {
	const router = useRouter();
	useShortcut("Escape", () => router.push(backHref));
	return (
		<div className="flex flex-col gap-4">
			<Button
				aria-keyshortcuts="Escape"
				variant="ghost"
				size="sm"
				nativeButton={false}
				className="-ml-2 w-fit text-muted-foreground"
				render={<Link href={backHref} />}
			>
				<ArrowLeftIcon data-icon="inline-start" />
				{backLabel}
			</Button>
			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="flex min-w-0 items-center gap-3">
					{Icon ? (
						<span className="icon-tile">
							<Icon />
						</span>
					) : null}
					<div className="flex min-w-0 flex-col gap-1">
						<h1 className="text-foreground break-all text-h3">{title}</h1>
						{badge}
						{description ? (
							<p className="text-sm text-muted-foreground">{description}</p>
						) : null}
					</div>
				</div>
				{actions ? (
					<div className="flex shrink-0 flex-wrap items-center gap-2">
						<ShortcutAction value="edit">{actions}</ShortcutAction>
					</div>
				) : null}
			</div>
		</div>
	);
}

/** One labelled fact in a `<dl>` grid. */
export function DetailField({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<dt className="text-sm text-muted-foreground">{label}</dt>
			<dd className="min-w-0 break-all text-sm">{children}</dd>
		</div>
	);
}

/** Labelled facts under a detail header. */
export function MetaStrip({
	items,
}: {
	items: readonly { label: string; value: React.ReactNode }[];
}) {
	return (
		<ItemGroup className="flex-row flex-wrap gap-2">
			{items.map((item) => (
				<Item key={item.label} size="sm" className="w-fit min-w-40 flex-1">
					<ItemContent className="min-w-0">
						<ItemTitle>{item.label}</ItemTitle>
						<ItemDescription className="flex min-w-0 items-center gap-1.5">
							{item.value}
						</ItemDescription>
					</ItemContent>
				</Item>
			))}
		</ItemGroup>
	);
}

/** The opensend frame + panel surface, for one data object. */
export function Surface({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("frame surface-shell", className)}>
			<div className="panel space-y-5">{children}</div>
		</div>
	);
}

/** One framed block of a settings page: what it is about, its controls, and
    a footer for the button that saves them. `flush` is for a table or an
    empty state, which bring their own inset. */
export function SettingsCard({
	title,
	heading,
	description,
	actions,
	footer,
	flush = false,
	inline = false,
	children,
}: {
	title?: string;
	heading?: React.ReactNode;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	footer?: React.ReactNode;
	flush?: boolean;
	inline?: boolean;
	children?: React.ReactNode;
}) {
	if (inline)
		return (
			<DetailSection title={title ?? ""} actions={actions}>
				{heading}
				{description && (
					<p className="text-sm text-muted-foreground">{description}</p>
				)}
				{children}
				{footer}
			</DetailSection>
		);
	return (
		<CardFrame>
			<Card>
				<CardHeader>
					{heading ?? (
						<CardTitle role="heading" aria-level={2} className="text-base">
							{title}
						</CardTitle>
					)}
					{description ? (
						<CardDescription>{description}</CardDescription>
					) : null}
					{actions ? <CardAction>{actions}</CardAction> : null}
				</CardHeader>
				{children ? (
					<CardContent
						className={cn("flex flex-col", flush ? "px-2" : "gap-5")}
					>
						{children}
					</CardContent>
				) : null}
				{footer ? <CardFooter className="gap-2">{footer}</CardFooter> : null}
			</Card>
		</CardFrame>
	);
}

/** Framed panel with a tab strip on top. */
export function PanelTabs({
	value,
	onValueChange,
	tabs,
	children,
}: {
	value: string;
	onValueChange: (value: string) => void;
	tabs: readonly { value: string; label: string }[];
	children: React.ReactNode;
}) {
	return (
		<div className="frame">
			<div className="panel overflow-hidden p-0">
				<Tabs
					value={value}
					onValueChange={(next) => {
						if (next) onValueChange(next);
					}}
					className="gap-0"
				>
					<div className="overflow-x-auto border-b border-border px-3 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
						<TabsList>
							{tabs.map((tab) => (
								<TabsTrigger key={tab.value} value={tab.value}>
									{tab.label}
								</TabsTrigger>
							))}
						</TabsList>
					</div>
					{children}
				</Tabs>
			</div>
		</div>
	);
}

export type EventTrailStep = {
	id: string;
	icon: LucideIcon;
	label: string;
	/** When it happened. A step without one is still ahead, and reads dimmed. */
	caption?: string;
};

/** Horizontal run of milestones: icon, label, and when each was reached. */
export function EventTrail({
	steps,
	className,
}: {
	steps: readonly EventTrailStep[];
	className?: string;
}) {
	return (
		<div className={cn("flex flex-wrap items-center gap-2", className)}>
			{steps.map((step, index) => {
				const Icon = step.icon;
				return (
					<React.Fragment key={step.id}>
						{index > 0 ? (
							<Separator orientation="vertical" className="h-8 self-center" />
						) : null}
						<Item
							size="xs"
							className={cn("w-fit", step.caption ? undefined : "opacity-50")}
						>
							<ItemMedia variant="icon">
								<Icon />
							</ItemMedia>
							<ItemContent>
								<ItemTitle>{step.label}</ItemTitle>
								{step.caption ? (
									<ItemDescription>{step.caption}</ItemDescription>
								) : null}
							</ItemContent>
						</Item>
					</React.Fragment>
				);
			})}
		</div>
	);
}

/* ----------------------------------------------------------------- tables */

/** Disable the frame when a table lives inside an existing panel or card. */
export function ResourceTable({
	children,
	headers,
	className,
	framed = true,
}: {
	headers: React.ReactNode;
	children: React.ReactNode;
	className?: string;
	framed?: boolean;
}) {
	return (
		<div className={cn(framed && "frame", className)}>
			<div className={cn(framed && "panel", "overflow-hidden p-0")}>
				<Table>
					<TableHeader>
						<TableRow>{headers}</TableRow>
					</TableHeader>
					<TableBody>{children}</TableBody>
				</Table>
			</div>
		</div>
	);
}

export function Th({
	children,
	className,
}: {
	children?: React.ReactNode;
	className?: string;
}) {
	return <TableHead className={className}>{children}</TableHead>;
}

/** Trails `value` by `delay`, so a controlled input can keep every keystroke
    while the query behind it only sees the pauses. */
export function useDebouncedValue<T>(value: T, delay = 250) {
	const [settled, setSettled] = React.useState(value);
	React.useEffect(() => {
		const timer = setTimeout(() => setSettled(value), delay);
		return () => clearTimeout(timer);
	}, [value, delay]);
	return settled;
}

export function useListSearch() {
	const [query, setQuery] = React.useState("");
	const search = useDebouncedValue(query);
	return { query, setQuery, search };
}

/* ------------------------------------------------------------ empty states */

export function EmptyState({
	icon: Icon,
	title,
	description,
	size = "default",
	children,
}: {
	icon: LucideIcon;
	title: string;
	description: string;
	/** `sm` sits inside another panel, so it drops the frame. */
	size?: "default" | "sm";
	children?: React.ReactNode;
}) {
	const body = (
		<Empty
			className={
				size === "sm"
					? "min-h-40 py-8"
					: "min-h-48 rounded-xl border border-border border-dashed py-10"
			}
		>
			<EmptyHeader>
				<EmptyMedia variant="icon" className="icon-tile border-0 shadow-none">
					<Icon className="size-4" />
				</EmptyMedia>
				<EmptyTitle role="heading" aria-level={size === "sm" ? 3 : 2}>
					{title}
				</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
			{children ? <EmptyContent>{children}</EmptyContent> : null}
		</Empty>
	);
	return size === "sm" ? body : <div className="frame">{body}</div>;
}

/** "X not found" with a way back to the list. */
export function NotFoundState({
	icon,
	noun,
	backHref,
	backLabel = `Back to ${noun}s`,
	description = "It may have been deleted.",
}: {
	icon: LucideIcon;
	noun: string;
	backHref: string;
	backLabel?: string;
	description?: string;
}) {
	return (
		<EmptyState
			icon={icon}
			title={`${sentenceCase(noun)} not found`}
			description={description}
		>
			<Button nativeButton={false} render={<Link href={backHref} />}>
				{backLabel}
			</Button>
		</EmptyState>
	);
}

/* ----------------------------------------------------------------- badges */

/** The tone as a dot class, for status dots beside text. */
export function toneDotClassName(tone: BadgeTone): string {
	switch (tone) {
		case "success":
			return "bg-success";
		case "destructive":
			return "bg-destructive";
		case "warning":
			return "bg-warning";
		case "info":
			return "bg-info";
		case "secondary":
			return "bg-muted-foreground";
		case "outline":
			return "bg-foreground";
	}
}

/** The same tone as a CSS color, for chart strokes and fills. */
export function toneColor(tone: BadgeTone): string {
	switch (tone) {
		case "success":
			return "var(--success)";
		case "destructive":
			return "var(--destructive)";
		case "warning":
			return "var(--warning)";
		case "info":
			return "var(--info)";
		case "secondary":
			return "var(--muted-foreground)";
		case "outline":
			return "var(--foreground)";
	}
}

/** Dot + word status badge. */
export function ToneBadge({ tone, label }: { tone: BadgeTone; label: string }) {
	return (
		<Badge variant={tone} dot>
			{label}
		</Badge>
	);
}

/* ------------------------------------------------------------- values */

export async function copyToClipboard(value: string, label?: string) {
	await navigator.clipboard.writeText(value);
	toast.success(label ? `${label} copied` : "Copied");
}

export function CopyButton({
	value,
	label,
}: {
	value: string;
	label?: string;
}) {
	const [copied, setCopied] = React.useState(false);
	const timer = React.useRef<number | null>(null);

	React.useEffect(() => {
		return () => {
			if (timer.current) window.clearTimeout(timer.current);
		};
	}, []);

	async function copy() {
		await copyToClipboard(value, label);
		setCopied(true);
		if (timer.current) window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setCopied(false), 1500);
	}

	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-xs"
			aria-label={label ? `Copy ${label}` : "Copy"}
			onClick={() => void copy()}
		>
			{copied ? <CheckIcon /> : <CopyIcon />}
		</Button>
	);
}

/** IDs, IPs, env keys: mono 13px, optionally copyable. */
export function MonoValue({
	children,
	copyValue,
}: {
	children: React.ReactNode;
	copyValue?: string;
}) {
	return (
		<span className="inline-flex max-w-full items-center gap-1">
			<code className="truncate font-mono text-[13px]">{children}</code>
			{copyValue ? <CopyButton value={copyValue} /> : null}
		</span>
	);
}

/** A record's machine name (a path, a URL) as the link to it. */
export function MonoLink({
	href,
	children,
}: {
	href: string;
	children: React.ReactNode;
}) {
	return (
		<Link
			href={href}
			className="font-mono text-[13px] underline decoration-dashed decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"
		>
			{children}
		</Link>
	);
}

/** A table's leading cell: the resource's icon tile, then its name. */
export function IconCell({
	icon: Icon,
	children,
}: {
	icon: LucideIcon;
	children: React.ReactNode;
}) {
	return (
		<div className="flex min-w-0 items-center gap-3">
			<span className="icon-tile size-8 shrink-0 rounded-lg [&_svg]:size-4">
				<Icon />
			</span>
			{children}
		</div>
	);
}

/** Monospace well for source and payloads, with an optional copy button. */
export function CodeWell({
	children,
	copyValue,
	className,
}: {
	children: React.ReactNode;
	copyValue?: string;
	className?: string;
}) {
	return (
		<div className="relative">
			<pre
				className={cn(
					"overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-4 font-mono text-mono",
					copyValue && "pr-12",
					className,
				)}
			>
				{children}
			</pre>
			{copyValue ? (
				<div className="absolute top-3 right-3">
					<CopyButton value={copyValue} />
				</div>
			) : null}
		</div>
	);
}

/** One titled block on a detail page, with room for controls by the title. */
export function DetailSection({
	title,
	actions,
	className,
	children,
}: {
	title: string;
	actions?: React.ReactNode;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<section className={cn("flex flex-col gap-3", className)}>
			<div className="flex flex-wrap items-center gap-2">
				<h2 className="min-w-0 flex-1 font-medium text-sm">{title}</h2>
				{actions}
			</div>
			{children}
		</section>
	);
}

/* ------------------------------------------------------------------ menus */

export function MoreMenu({ children }: { children: React.ReactNode }) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label="More options"
						className="text-muted-foreground"
					/>
				}
			>
				<MoreHorizontalIcon />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-48">
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Floating bulk-action bar, pinned to the bottom of the content column while rows are selected. */
export function SelectionBar({
	count,
	onClear,
	children,
}: {
	count: number;
	onClear: () => void;
	children: React.ReactNode;
}) {
	useShortcut("Escape", onClear, { enabled: count > 0, priority: 20 });
	if (count === 0) return null;
	return (
		<div className="pointer-events-none sticky bottom-6 z-40 order-last mt-auto flex h-0 items-end justify-center">
			<div
				role="toolbar"
				aria-label="Bulk actions"
				className="pointer-events-auto flex animate-in items-center gap-1 rounded-xl border border-border bg-surface p-1.5 shadow-lifted duration-200 fade-in slide-in-from-bottom-2"
			>
				<p className="px-2.5 font-medium text-sm tabular-nums">
					{count} selected
				</p>
				<Separator orientation="vertical" className="h-5 self-center" />
				<ShortcutAction value="delete">{children}</ShortcutAction>
				<Separator orientation="vertical" className="h-5 self-center" />
				<Button
					variant="ghost"
					size="icon"
					aria-label="Clear selection"
					aria-keyshortcuts="Escape"
					onClick={onClear}
				>
					<XIcon />
				</Button>
			</div>
		</div>
	);
}

/* ---------------------------------------------------------------- dialogs */

export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel = "Delete",
	onConfirm,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	confirmLabel?: string;
	onConfirm: () => unknown | Promise<unknown>;
}) {
	const { scope: confirmScope, button: confirmButton } =
		useConfirmShortcut(open);
	const modifier = useShortcutModifier();
	const [pending, setPending] = React.useState(false);
	const [error, setError] = React.useState("");
	return (
		<AlertDialog
			open={open}
			onOpenChange={(next) => {
				if (!pending) onOpenChange(next);
			}}
		>
			<AlertDialogContent ref={confirmScope}>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<Button
						ref={confirmButton}
						aria-keyshortcuts={
							modifier === "⌘" ? "Meta+Enter" : "Control+Enter"
						}
						variant="destructive"
						disabled={pending}
						onClick={async () => {
							setPending(true);
							setError("");
							try {
								await onConfirm();
								onOpenChange(false);
							} catch (e) {
								setError(errorMessage(e));
							} finally {
								setPending(false);
							}
						}}
					>
						{confirmLabel} <Kbd aria-hidden="true">{modifier} Enter</Kbd>
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

/** A confirmation for what cannot be undone: the button stays off until the
    phrase is typed, and the acknowledgement ticked when there is one. */
export function TypeToConfirmDialog(props: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: React.ReactNode;
	/** What has to be typed, exactly. */
	phrase: string;
	acknowledgement?: string;
	confirmLabel: string;
	onConfirm: () => unknown | Promise<unknown>;
	/** What is about to go, shown under the description. */
	children?: React.ReactNode;
}) {
	return (
		<AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
			{/* Mounted per opening, so the phrase is typed afresh each time. */}
			{props.open ? <TypeToConfirmForm {...props} /> : null}
		</AlertDialog>
	);
}

function TypeToConfirmForm({
	onOpenChange,
	title,
	description,
	phrase,
	acknowledgement,
	confirmLabel,
	onConfirm,
	children,
}: React.ComponentProps<typeof TypeToConfirmDialog>) {
	const { scope: confirmScope, button: confirmButton } =
		useConfirmShortcut(true);
	const modifier = useShortcutModifier();
	const id = React.useId();
	const [typed, setTyped] = React.useState("");
	const [acknowledged, setAcknowledged] = React.useState(false);
	const [pending, setPending] = React.useState(false);
	const [error, setError] = React.useState("");
	const ready = typed === phrase && (acknowledged || !acknowledgement);

	return (
		<AlertDialogContent size="md" ref={confirmScope}>
			<form
				className="contents"
				onSubmit={async (event) => {
					event.preventDefault();
					if (!ready || pending) return;
					setPending(true);
					setError("");
					try {
						await onConfirm();
						onOpenChange(false);
					} catch (e) {
						setError(errorMessage(e));
					} finally {
						setPending(false);
					}
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				{children}
				<FieldGroup>
					<Field>
						<FieldLabel htmlFor={id} className="font-normal">
							<span>
								Type <span className="select-all font-medium">{phrase}</span> to
								confirm.
							</span>
						</FieldLabel>
						<Input
							id={id}
							value={typed}
							autoComplete="off"
							onChange={(event) => setTyped(event.target.value)}
							autoFocus
						/>
					</Field>
					{acknowledgement ? (
						<Field orientation="horizontal" className="items-start">
							<Checkbox
								id={`${id}-ack`}
								checked={acknowledged}
								onCheckedChange={(checked) => setAcknowledged(checked === true)}
							/>
							<FieldLabel htmlFor={`${id}-ack`} className="font-normal">
								{acknowledgement}
							</FieldLabel>
						</Field>
					) : null}
				</FieldGroup>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				<AlertDialogFooter>
					<AlertDialogCancel type="button">Cancel</AlertDialogCancel>
					<Button
						ref={confirmButton}
						aria-keyshortcuts={
							modifier === "⌘" ? "Meta+Enter" : "Control+Enter"
						}
						type="submit"
						variant="destructive"
						disabled={!ready || pending}
					>
						{confirmLabel} <Kbd aria-hidden="true">{modifier} Enter</Kbd>
					</Button>
				</AlertDialogFooter>
			</form>
		</AlertDialogContent>
	);
}

/** One text value, asked for in a dialog: a rename, an alias. The value is
    trimmed, and `validate` returns what is wrong with it, or null. */
export function TextFieldDialog(props: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	label: string;
	value: string;
	validate: (value: string) => string | null;
	onSubmit: (value: string) => unknown | Promise<unknown>;
	mono?: boolean;
}) {
	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			{/* Mounted per opening, so the field starts from the current value. */}
			{props.open ? <TextFieldDialogForm {...props} /> : null}
		</Dialog>
	);
}

function TextFieldDialogForm({
	onOpenChange,
	title,
	description,
	label,
	value: initial,
	validate,
	onSubmit,
	mono,
}: React.ComponentProps<typeof TextFieldDialog>) {
	const [pending, setPending] = React.useState(false);
	const id = React.useId();
	const [value, setValue] = React.useState(initial);
	const [error, setError] = React.useState<string | null>(null);

	return (
		<DialogContent className="sm:max-w-md">
			<form
				onSubmit={async (event) => {
					event.preventDefault();
					const next = value.trim();
					const problem = validate(next);
					if (problem) {
						setError(problem);
						return;
					}
					if (pending) return;
					setPending(true);
					try {
						await onSubmit(next);
						onOpenChange(false);
					} catch (e) {
						setError(errorMessage(e));
					} finally {
						setPending(false);
					}
				}}
			>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<FieldGroup className="py-4">
					<Field>
						<FieldLabel htmlFor={id}>{label}</FieldLabel>
						<Input
							id={id}
							value={value}
							className={mono ? "font-mono" : undefined}
							onChange={(event) => {
								setValue(event.target.value);
								setError(null);
							}}
							autoFocus
						/>
						{error ? <FieldError>{error}</FieldError> : null}
					</Field>
				</FieldGroup>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>
						Cancel
					</DialogClose>
					<Button type="submit" disabled={pending}>
						Save
					</Button>
				</DialogFooter>
			</form>
		</DialogContent>
	);
}

/* ---------------------------------------------------------------- choices */

/** A choice between a few options that each need a sentence of explanation. */
export function RadioCards<Value extends string>({
	value,
	onChange,
	options,
	disabled,
	"aria-label": ariaLabel,
}: {
	value: Value;
	onChange: (value: Value) => void;
	options: readonly { value: Value; label: string; description: string }[];
	disabled?: boolean;
	"aria-label"?: string;
}) {
	return (
		<RadioGroup
			value={value}
			onValueChange={(next) => onChange(next as Value)}
			disabled={disabled}
			aria-label={ariaLabel}
			className="gap-3"
		>
			{options.map((option) => (
				// biome-ignore lint/a11y/noLabelWithoutControl: the Base UI radio inside is the control
				<label
					key={option.value}
					className="flex items-start gap-3 rounded-lg border border-border p-3 has-data-checked:border-foreground has-data-checked:bg-muted"
				>
					<RadioGroupItem value={option.value} className="mt-0.5" />
					<span>
						<span className="block font-medium text-sm">{option.label}</span>
						<span className="text-sm text-muted-foreground">
							{option.description}
						</span>
					</span>
				</label>
			))}
		</RadioGroup>
	);
}

/* ----------------------------------------------------------------- hints */

/** Info icon that explains the label beside it on hover or focus. */
export function InfoTip({
	children,
	label = "More information",
}: {
	children: React.ReactNode;
	label?: string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						aria-label={label}
					/>
				}
			>
				<InfoIcon />
			</TooltipTrigger>
			<TooltipContent className="flex flex-col items-start gap-1.5 text-left">
				{children}
			</TooltipContent>
		</Tooltip>
	);
}

/* --------------------------------------------------------------- secrets */

/** Read-only secret behind dots, with a reveal toggle and a copy button. */
export function SecretField({
	value,
	label = "Secret",
	id,
}: {
	value: string;
	label?: string;
	id?: string;
}) {
	const [revealed, setRevealed] = React.useState(false);
	return (
		<InputGroup>
			<InputGroupInput
				id={id}
				readOnly
				credential
				name="service-secret"
				type={revealed ? "text" : "password"}
				aria-label={label}
				value={revealed ? value : "•".repeat(value.length)}
				className="font-mono text-[13px]"
			/>
			<InputGroupAddon align="inline-end">
				<InputGroupButton
					size="icon-xs"
					aria-label={revealed ? `Hide ${label}` : `Show ${label}`}
					onClick={() => setRevealed((current) => !current)}
				>
					{revealed ? <EyeOffIcon /> : <EyeIcon />}
				</InputGroupButton>
				<CopyButton value={value} label={label} />
			</InputGroupAddon>
		</InputGroup>
	);
}
