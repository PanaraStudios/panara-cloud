export type ShortcutKey = Pick<
	KeyboardEvent,
	| "key"
	| "metaKey"
	| "ctrlKey"
	| "altKey"
	| "shiftKey"
	| "repeat"
	| "isComposing"
	| "keyCode"
>;

export function isMacPlatform(platform: string) {
	return /Mac|iPhone|iPad|iPod/i.test(platform);
}

/** Extensions and synthetic events can dispatch keydown without KeyboardEvent.key. */
export function shortcutEventKey(key: unknown): string | null {
	return typeof key === "string" && key.length > 0 ? key.toLowerCase() : null;
}

export function matchesShortcut(
	event: ShortcutKey,
	shortcut: string,
	mac: boolean,
) {
	const eventKey = shortcutEventKey(event.key);
	if (
		eventKey === null ||
		event.isComposing ||
		event.keyCode === 229 ||
		event.repeat ||
		event.altKey
	)
		return false;
	const mod = shortcut.startsWith("mod+");
	const rest = mod ? shortcut.slice(4) : shortcut;
	const shift = rest.startsWith("shift+");
	const key = shift ? rest.slice(6) : rest;
	if (event.metaKey !== (mod && mac) || event.ctrlKey !== (mod && !mac))
		return false;
	// A printable symbol such as '?' carries its own Shift on US keyboards;
	// every other key takes Shift only when the shortcut names it.
	if (event.shiftKey !== shift && key !== "?") return false;
	return eventKey === key.toLowerCase();
}

export const SEQUENCE_TIMEOUT = 1000;
export function sequenceKey(
	prefix: { key: string; at: number } | null,
	key: string,
	now: number,
) {
	return prefix && now - prefix.at < SEQUENCE_TIMEOUT
		? `${prefix.key} ${key}`
		: key;
}

export function actionShortcut(action: string | null, label: string) {
	if (action === "create" && /^(Create|Add)\b/.test(label)) return "c";
	if (action === "edit" && /^Edit\b/.test(label)) return "e";
	if (action === "save" && /^Save\b/.test(label)) return "mod+s";
	if (action === "delete" && /^Delete\b/.test(label)) return "Backspace";
	return null;
}

// "G then letter" inside a service or a server:
// [letter, title, section under its URL].
export const SERVICE_SHORTCUTS = [
	["o", "Overview", undefined],
	["c", "Source (applications, compose)", "source"],
	["d", "Deployments", "deployments"],
	["l", "Logs", "logs"],
	["m", "Metrics", "metrics"],
	["b", "Backups (databases)", "backups"],
	["e", "Environment variables", "settings/environment"],
] as const;

export const SERVER_SHORTCUTS = [
	["o", "Overview", undefined],
	["c", "Containers", "containers"],
	["t", "Terminal", "terminal"],
	["m", "Monitoring", "monitoring"],
] as const;

export const ACCOUNT_SHORTCUT = "u";
