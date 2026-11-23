import {
	ArchiveIcon,
	ArrowDown01Icon,
	ArrowDown10Icon,
	ArrowDownAZIcon,
	ArrowDownZAIcon,
	ArrowLeftRightIcon,
	AsteriskIcon,
	AtSignIcon,
	BanIcon,
	BlocksIcon,
	BoxIcon,
	Building2Icon,
	CalendarArrowDownIcon,
	CalendarArrowUpIcon,
	CalendarDaysIcon,
	CalendarRangeIcon,
	CheckIcon,
	CircuitBoardIcon,
	ClockArrowDownIcon,
	ClockArrowUpIcon,
	ClockIcon,
	CrownIcon,
	DatabaseIcon,
	EthernetPortIcon,
	FileCodeIcon,
	FilesIcon,
	FileTextIcon,
	FolderIcon,
	FolderSymlinkIcon,
	GitCommitHorizontalIcon,
	GlobeIcon,
	HammerIcon,
	HardDriveIcon,
	HardHatIcon,
	HistoryIcon,
	InfinityIcon,
	KeyRoundIcon,
	LayersIcon,
	LayoutTemplateIcon,
	Link2Icon,
	LockIcon,
	LockOpenIcon,
	type LucideIcon,
	MapPinIcon,
	NetworkIcon,
	PackageIcon,
	PackagePlusIcon,
	PanelsTopLeftIcon,
	PauseIcon,
	PencilLineIcon,
	PlayIcon,
	PowerIcon,
	PowerOffIcon,
	RadioIcon,
	RocketIcon,
	RotateCcwIcon,
	RouterIcon,
	ScrollTextIcon,
	SearchIcon,
	ServerIcon,
	ShieldCheckIcon,
	ShieldUserIcon,
	SlidersHorizontalIcon,
	SnowflakeIcon,
	SparkleIcon,
	SquareIcon,
	SquareTerminalIcon,
	StepForwardIcon,
	TableIcon,
	TagIcon,
	TerminalIcon,
	TextAlignStartIcon,
	TimerIcon,
	TrainFrontIcon,
	Undo2Icon,
	UploadIcon,
	UserIcon,
	WaypointsIcon,
} from "lucide-react";

/** Logos an option can carry; `OptionMark` draws them. */
export type OptionBrand =
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis"
	| "libsql"
	| "github"
	| "gitlab"
	| "bitbucket"
	| "gitea"
	| "git"
	| "docker"
	| "panel";

/** The status colours of docs/design.md's one status vocabulary. */
export type OptionTone =
	| "success"
	| "info"
	| "warning"
	| "destructive"
	| "secondary";

/** What stands before an option: a glyph, a brand's logo, a status dot, or
    the first letter of something its user named. */
export type OptionMark =
	| { glyph: LucideIcon }
	| { brand: OptionBrand }
	| { tone: OptionTone }
	| { monogram: string };

const glyphs = (
	icon: LucideIcon,
	...labels: string[]
): [string, OptionMark][] => labels.map((label) => [label, { glyph: icon }]);
const brands = (
	brand: OptionBrand,
	...labels: string[]
): [string, OptionMark][] => labels.map((label) => [label, { brand }]);
const tones = (tone: OptionTone, ...labels: string[]): [string, OptionMark][] =>
	labels.map((label) => [label, { tone }]);

// One concept, one mark: the glyphs match lib/navigation.ts and
// components/icons for the same things.
const OPTIONS = new Map<string, OptionMark>([
	/* sort orders */
	...glyphs(HistoryIcon, "last activity", "recent activity", "last updated"),
	...glyphs(ClockArrowDownIcon, "recently deployed", "last deployed"),
	...glyphs(ClockArrowUpIcon, "oldest deployed"),
	...glyphs(ArrowDownAZIcon, "name", "a-z"),
	...glyphs(ArrowDownZAIcon, "z-a"),
	...glyphs(CalendarArrowDownIcon, "newest", "newest first"),
	...glyphs(CalendarArrowUpIcon, "oldest", "oldest first"),

	/* everything, nothing, your own */
	...glyphs(AsteriskIcon, "all", "any"),
	...glyphs(BanIcon, "none"),
	...glyphs(InfinityIcon, "never", "permanent"),
	...glyphs(TimerIcon, "temporary"),
	...glyphs(SlidersHorizontalIcon, "custom"),

	/* statuses */
	...tones(
		"success",
		"live",
		"running",
		"ready",
		"healthy",
		"active",
		"success",
		"in use",
		"2xx",
	),
	...tones("info", "deploying", "in progress", "building", "info", "3xx"),
	...tones(
		"warning",
		"restarting",
		"starting",
		"degraded",
		"warning",
		"pending",
		"4xx",
	),
	...tones(
		"destructive",
		"failed",
		"failing",
		"error",
		"dead",
		"unreachable",
		"5xx",
	),
	...tones(
		"secondary",
		"stopped",
		"exited",
		"paused",
		"created",
		"removing",
		"queued",
		"not deployed",
		"cancelled",
		"superseded",
		"inactive",
		"ended",
		"unused",
		"debug",
	),

	/* on and off */
	...glyphs(PowerIcon, "enabled", "on"),
	...glyphs(PowerOffIcon, "disabled", "off"),
	...glyphs(CheckIcon, "allowed"),

	/* services and databases */
	...glyphs(GlobeIcon, "application", "applications"),
	...glyphs(CircuitBoardIcon, "compose", "compose bundle"),
	...glyphs(DatabaseIcon, "database", "databases"),
	...brands("postgres", "postgresql", "postgres"),
	...brands("mysql", "mysql"),
	...brands("mariadb", "mariadb"),
	...brands("mongo", "mongodb", "mongo"),
	...brands("redis", "redis"),
	...brands("libsql", "libsql"),
	...brands("docker", "docker compose", "docker image", "dockerfile", "docker"),
	...glyphs(BlocksIcon, "stack", "swarm stack", "swarm tasks"),

	/* sources */
	...brands("github", "github"),
	...brands("gitlab", "gitlab"),
	...brands("bitbucket", "bitbucket"),
	...brands("gitea", "gitea"),
	...brands("git", "git", "git url"),
	...glyphs(PencilLineIcon, "raw", "write here"),
	...glyphs(UploadIcon, "upload .zip"),
	...glyphs(GitCommitHorizontalIcon, "on push"),
	...glyphs(TagIcon, "on tag"),
	...glyphs(PackagePlusIcon, "on image push"),

	/* build types */
	...glyphs(SnowflakeIcon, "nixpacks"),
	...glyphs(TrainFrontIcon, "railpack"),
	...glyphs(
		PackageIcon,
		"buildpacks",
		"heroku buildpacks",
		"paketo buildpacks",
	),
	...glyphs(PanelsTopLeftIcon, "static"),

	/* things the sidebar and the tabs already name */
	...glyphs(FolderIcon, "projects", "project export"),
	...glyphs(BoxIcon, "services", "containers"),
	...glyphs(ServerIcon, "servers", "host"),
	...glyphs(LayersIcon, "images", "custom image"),
	...glyphs(ScrollTextIcon, "logs", "access log"),
	...glyphs(
		SquareTerminalIcon,
		"terminal",
		"one-line command",
		"run a command",
	),
	...glyphs(SearchIcon, "inspect"),
	...glyphs(FilesIcon, "files"),
	...glyphs(FileCodeIcon, "config files"),
	...glyphs(EthernetPortIcon, "ports & environment"),
	...glyphs(LayoutTemplateIcon, "template"),
	...glyphs(TableIcon, "table"),

	/* networks and protocols */
	...glyphs(Link2Icon, "bridge"),
	...glyphs(WaypointsIcon, "overlay", "ingress"),
	...glyphs(RouterIcon, "macvlan", "ipvlan"),
	...glyphs(NetworkIcon, "internal", "sctp"),
	...glyphs(GlobeIcon, "external", "internet access", "http & https"),
	...glyphs(ArrowLeftRightIcon, "tcp"),
	...glyphs(RadioIcon, "udp"),
	...glyphs(LockIcon, "https only", "https", "isolated", "build secret"),
	...glyphs(LockOpenIcon, "http only", "http"),
	...glyphs(ShieldCheckIcon, "let's encrypt"),

	/* mounts */
	...glyphs(HardDriveIcon, "volume"),
	...glyphs(FolderSymlinkIcon, "bind"),
	...glyphs(FileTextIcon, "file", "raw .env"),

	/* servers and swarm */
	...brands(
		"panel",
		"panara cloud",
		"panara cloud host",
		"panara cloud server",
		"this panara cloud server",
	),
	...glyphs(RocketIcon, "deploy", "deploy server"),
	...glyphs(HammerIcon, "build", "build server", "build arg"),
	...glyphs(CrownIcon, "manager", "owner"),
	...glyphs(HardHatIcon, "worker"),
	...glyphs(FilesIcon, "replicated"),
	...glyphs(GlobeIcon, "global"),
	...glyphs(RouterIcon, "vip"),
	...glyphs(WaypointsIcon, "dns round robin"),
	// Two shells are a choice between two things: each has its own glyph, so
	// a list of them is marked (a list that repeats one mark stays bare).
	...glyphs(SquareTerminalIcon, "bash", "/bin/bash"),
	...glyphs(TerminalIcon, "sh", "/bin/sh"),
	...glyphs(BanIcon, "empty", "no volumes found"),
	...glyphs(KeyRoundIcon, "ssh key", "key only", "manual (ssh)"),

	/* people */
	...glyphs(ShieldUserIcon, "admin"),
	...glyphs(UserIcon, "member", "personal account"),
	...glyphs(Building2Icon, "organization"),

	/* what a rollout or a restart does */
	...glyphs(PlayIcon, "runtime", "start first"),
	...glyphs(SquareIcon, "stop first"),
	...glyphs(PauseIcon, "pause"),
	...glyphs(StepForwardIcon, "continue"),
	...glyphs(Undo2Icon, "rollback"),
	...glyphs(RotateCcwIcon, "on failure"),

	/* log viewer */
	...glyphs(ClockIcon, "timestamps"),
]);

// A span of time carries its unit: a timer for seconds and minutes, a clock
// for hours, a calendar from a day up.
const UNITS: readonly (readonly [RegExp, LucideIcon])[] = [
	[/^(s|secs?|seconds?|m|mins?|minutes?)$/, TimerIcon],
	[/^(h|hrs?|hours?)$/, ClockIcon],
	[/^(d|days?)$/, CalendarDaysIcon],
	[/^(w|weeks?|mo|months?|y|years?)$/, CalendarRangeIcon],
];
const SPAN = /^(?:(last|past|every) )?(\d+)? ?([a-z]+)$/;

// The direction of a sort, whatever is sorted ("Type (A-Z)", "Port (low-high)").
const ORDERS: readonly (readonly [RegExp, LucideIcon])[] = [
	[/\(a-z\)$/, ArrowDownAZIcon],
	[/\(z-a\)$/, ArrowDownZAIcon],
	[/\(low-high\)$/, ArrowDown01Icon],
	[/\(high-low\)$/, ArrowDown10Icon],
];

function timeSpan(text: string): LucideIcon | null {
	const [, prefix, amount, unit] = SPAN.exec(text) ?? [];
	if (!unit || (!prefix && !amount)) return null;
	return UNITS.find(([pattern]) => pattern.test(unit))?.[1] ?? null;
}

/** The mark for an option from its label ("Last activity", "PostgreSQL",
    "Failed", "Last 6 hours"), so the same choice looks the same in every
    select, pill row and menu. Null for a label that is data (a project's
    name, a region, a number) or has no mark that says something. */
export function optionMark(label: string): OptionMark | null {
	const text = normalize(label);
	if (!text) return null;
	const exact = OPTIONS.get(text);
	if (exact) return exact;
	const order = ORDERS.find(([pattern]) => pattern.test(text))?.[1];
	if (order) return { glyph: order };
	const span = timeSpan(text);
	if (span) return { glyph: span };
	// "All statuses", "All 7": what is counted or listed comes after.
	if (/^all( [a-z0-9 ]+)?$/.test(text)) return { glyph: AsteriskIcon };
	// "VIP (virtual IP)", "Member · only granted projects": the note after the
	// name doesn't change what it is.
	const name = text.replace(/ (\(.*\)|· .*)$/, "");
	return name === text ? null : (OPTIONS.get(name) ?? null);
}

/** What a list of names lists. Options that are things somebody named have
    no mark of their own, so the list says what they are (`names` on a
    select, a pill row or a menu) and each one gets the mark of its kind: a
    project its monogram, the rest the glyph the sidebar and the settings use
    for the same thing. */
export type OptionNames = keyof typeof NAMED | "project";

const NAMED = {
	server: ServerIcon,
	environment: LayersIcon,
	service: BoxIcon,
	container: BoxIcon,
	registry: PackageIcon,
	sshKey: KeyRoundIcon,
	storage: ArchiveIcon,
	volume: HardDriveIcon,
	organization: Building2Icon,
	ai: SparkleIcon,
	email: AtSignIcon,
	secrets: LockIcon,
	region: MapPinIcon,
	version: TagIcon,
	record: FileTextIcon,
	node: DatabaseIcon,
	rows: TableIcon,
	domain: GlobeIcon,
	category: TagIcon,
	account: UserIcon,
	schedule: ClockIcon,
	limit: SlidersHorizontalIcon,
	lines: TextAlignStartIcon,
} satisfies Record<string, LucideIcon>;

// The options a list of names has besides the names, which keep their own
// mark. Anything else in the table is ignored there: a server called "Live"
// is still a server.
const BESIDE_NAMES =
	/^(all( [a-z0-9 ]+)?|any|none|empty|panara cloud( host| server)?|this panara cloud server)$/;

const normalize = (label: string) =>
	label
		.toLowerCase()
		.replace(/[’‘]/g, "'")
		.replace(/(…|\.{3})/g, "")
		.replace(/\s+/g, " ")
		.trim();

/** The mark of one option in a list of `names`. */
export function nameMark(names: OptionNames, label: string): OptionMark {
	const text = normalize(label).replace(/ (\(.*\)|· .*)$/, "");
	if (BESIDE_NAMES.test(text)) {
		const known = optionMark(text);
		if (known) return known;
	}
	if (names !== "project") return { glyph: NAMED[names] };
	return { monogram: label.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? "·" };
}

const same = (a: OptionMark, b: OptionMark) =>
	"glyph" in a
		? "glyph" in b && a.glyph === b.glyph
		: "brand" in a
			? "brand" in b && a.brand === b.brand
			: "tone" in a
				? "tone" in b && a.tone === b.tone
				: "monogram" in b && a.monogram === b.monogram;

/** The marks for one list of options, or null when the list gets none: a
    list is marked whole or not at all, so one unknown label (a project's
    name between "All projects" and the rest) leaves every row bare, and so
    does a list whose rows would all repeat one mark. `undefined` entries are
    rows that bring a mark of their own. With `names` every label is a name
    of that kind, and the list is always marked. */
export function optionMarks(
	labels: readonly (string | undefined)[],
	names?: OptionNames,
): (OptionMark | null)[] | null {
	if (names) {
		return labels.length === 0
			? null
			: labels.map((label) =>
					label === undefined ? null : nameMark(names, label),
				);
	}
	const marks: (OptionMark | null)[] = [];
	let first: OptionMark | null = null;
	let varied = false;
	let own = false;
	for (const label of labels) {
		if (label === undefined) {
			own = true;
			marks.push(null);
			continue;
		}
		const mark = optionMark(label);
		if (!mark) return null;
		if (first && !same(first, mark)) varied = true;
		first ??= mark;
		marks.push(mark);
	}
	if (!first) return null;
	return marks.length === 1 || varied || own ? marks : null;
}
