import {
	ArchiveRestoreIcon,
	ArrowDownToLineIcon,
	ArrowLeftIcon,
	ArrowRightLeftIcon,
	ArrowUpRightIcon,
	BanIcon,
	BellIcon,
	CheckCheckIcon,
	CheckIcon,
	ChevronDownIcon,
	CircleArrowUpIcon,
	ClipboardPasteIcon,
	CopyIcon,
	CopyPlusIcon,
	DatabaseBackupIcon,
	DownloadIcon,
	EyeIcon,
	EyeOffIcon,
	FileInputIcon,
	FileOutputIcon,
	FlaskConicalIcon,
	FolderInputIcon,
	GlobeIcon,
	HammerIcon,
	ListFilterIcon,
	ListIcon,
	LockIcon,
	LockOpenIcon,
	LogInIcon,
	LogOutIcon,
	type LucideIcon,
	OctagonXIcon,
	PaintbrushIcon,
	PaperclipIcon,
	PauseIcon,
	PencilIcon,
	PlayIcon,
	PlugIcon,
	PlusIcon,
	PowerIcon,
	PowerOffIcon,
	RefreshCwIcon,
	RocketIcon,
	RotateCcwIcon,
	RotateCwIcon,
	SaveIcon,
	ScrollTextIcon,
	SearchIcon,
	SendIcon,
	SettingsIcon,
	SlidersHorizontalIcon,
	SquareIcon,
	SquareTerminalIcon,
	Trash2Icon,
	Undo2Icon,
	UnplugIcon,
	UploadIcon,
	UserPlusIcon,
	WandSparklesIcon,
	WrenchIcon,
	XIcon,
} from "lucide-react";
import { Children, type ReactNode } from "react";

// Whole-label rules, tried in order before the verb table: a later word
// decides the icon ("Open terminal", "View logs", "Back up now").
const PHRASES: readonly (readonly [RegExp, LucideIcon | null])[] = [
	// Leaving a dialog or a step is not an action.
	[/^(cancel|close|done|dismiss|next|previous|continue|skip\b.*|keep)$/, null],
	[/\bterminal\b/, SquareTerminalIcon],
	[/\blogs?\b(?! in)/, ScrollTextIcon],
	[/^(sign|log) out\b/, LogOutIcon],
	[/^(sign|log)(ing)? in\b/, LogInIcon],
	[/^(back up|set up backup)\b/, DatabaseBackupIcon],
	[/^back\b/, ArrowLeftIcon],
	[/^(rollback|roll back\b.*)$/, Undo2Icon],
	[/^turn on\b/, PowerIcon],
	[/^turn off\b/, PowerOffIcon],
	[/^(set up|run setup|gpu setup)\b/, WrenchIcon],
	[/^(try again|start over)\b/, RotateCcwIcon],
	[/^(show|load) (more|older)\b/, ChevronDownIcon],
	[/^update to v/, CircleArrowUpIcon],
	[/^(mark for deletion|wipe)\b/, Trash2Icon],
	[/^unmark\b/, Undo2Icon],
	[/^cancel\b/, OctagonXIcon],
	[/^i.ve saved\b/, CheckIcon],
	[/^select all\b/, CheckCheckIcon],
	[/^force (remove|delete)\b/, Trash2Icon],
];

// Tried when the first word is no verb ("Rollback settings").
const NOUNS: readonly (readonly [RegExp, LucideIcon])[] = [
	[/\bsettings$/, SettingsIcon],
	[/^notification/, BellIcon],
	[/^domains?$/, GlobeIcon],
	[/ command$/, SquareTerminalIcon],
	// A toggle that narrows a list ("Errors only").
	[/ only$/, ListFilterIcon],
];

const VERBS: Record<string, LucideIcon> = {
	add: PlusIcon,
	new: PlusIcon,
	create: PlusIcon,
	use: PlusIcon,
	save: SaveIcon,
	update: SaveIcon,
	apply: CheckIcon,
	confirm: CheckIcon,
	accept: CheckIcon,
	join: CheckIcon,
	authorize: CheckIcon,
	verify: CheckIcon,
	validate: CheckIcon,
	finish: CheckIcon,
	delete: Trash2Icon,
	remove: Trash2Icon,
	deploy: RocketIcon,
	redeploy: RocketIcon,
	start: PlayIcon,
	run: PlayIcon,
	resume: PlayIcon,
	stop: SquareIcon,
	pause: PauseIcon,
	kill: OctagonXIcon,
	restart: RotateCwIcon,
	reload: RotateCwIcon,
	rebuild: HammerIcon,
	move: FolderInputIcon,
	transfer: ArrowRightLeftIcon,
	switch: ArrowRightLeftIcon,
	duplicate: CopyPlusIcon,
	copy: CopyIcon,
	paste: ClipboardPasteIcon,
	pick: ListIcon,
	select: ListIcon,
	choose: ListIcon,
	edit: PencilIcon,
	rename: PencilIcon,
	change: PencilIcon,
	import: FileInputIcon,
	export: FileOutputIcon,
	download: DownloadIcon,
	load: DownloadIcon,
	upload: UploadIcon,
	refresh: RefreshCwIcon,
	check: RefreshCwIcon,
	"re-check": RefreshCwIcon,
	retry: RotateCcwIcon,
	reset: RotateCcwIcon,
	undo: Undo2Icon,
	discard: Undo2Icon,
	restore: ArchiveRestoreIcon,
	generate: WandSparklesIcon,
	regenerate: WandSparklesIcon,
	random: WandSparklesIcon,
	test: FlaskConicalIcon,
	connect: PlugIcon,
	disconnect: UnplugIcon,
	attach: PaperclipIcon,
	invite: UserPlusIcon,
	send: SendIcon,
	resend: SendIcon,
	request: SendIcon,
	open: ArrowUpRightIcon,
	view: EyeIcon,
	preview: EyeIcon,
	inspect: SearchIcon,
	review: EyeIcon,
	show: EyeIcon,
	reveal: EyeIcon,
	hide: EyeOffIcon,
	clear: XIcon,
	decline: XIcon,
	clean: PaintbrushIcon,
	prune: PaintbrushIcon,
	enable: PowerIcon,
	activate: PowerIcon,
	reactivate: PowerIcon,
	disable: PowerOffIcon,
	deactivate: PowerOffIcon,
	lock: LockIcon,
	unlock: LockOpenIcon,
	unban: LockOpenIcon,
	revoke: BanIcon,
	leave: LogOutIcon,
	follow: ArrowDownToLineIcon,
	configure: SlidersHorizontalIcon,
	reconfigure: SlidersHorizontalIcon,
	set: SlidersHorizontalIcon,
	raise: SlidersHorizontalIcon,
	install: DownloadIcon,
};

// "Saving…" keeps the icon of "Save".
const stem = (word: string) => {
	if (VERBS[word] || !word.endsWith("ing")) return word;
	const base = word.slice(0, -3);
	return VERBS[base] ? base : VERBS[`${base}e`] ? `${base}e` : word;
};

/** A label that is only text, or null when the children carry anything else
    (an icon of their own, a badge). */
export function plainLabel(children: ReactNode): string | null {
	let text = "";
	for (const child of Children.toArray(children)) {
		if (typeof child !== "string" && typeof child !== "number") return null;
		text += child;
	}
	return text.trim() ? text : null;
}

/** The icon for an action from its label ("Deploy", "Save ports", "Delete…"),
    so the same action carries the same icon on every button and menu item.
    Null when the label isn't an action the table knows. */
export function actionIcon(label: string): LucideIcon | null {
	const text = label
		.toLowerCase()
		.replace(/(…|\.{3})/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return null;
	for (const [pattern, icon] of PHRASES) {
		if (pattern.test(text)) return icon;
	}
	const verb = VERBS[stem(text.split(" ")[0] ?? "")];
	if (verb) return verb;
	return NOUNS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}
