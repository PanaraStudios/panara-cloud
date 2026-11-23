/* Parse and write `.env` text as rows, keeping everything the table does not
   touch (comments, blank lines, quoting, `export`) byte for byte. */

export type EnvScope = "runtime" | "build" | "secret";

export type EnvLine =
	| { kind: "var"; key: string; value: string; raw: string }
	| { kind: "other"; raw: string };

const VAR_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;

export function parseEnv(text: string): EnvLine[] {
	if (!text) return [];
	return text.split("\n").map((raw) => {
		const match = VAR_LINE.exec(raw);
		return match
			? { kind: "var", key: match[1] as string, value: match[2] ?? "", raw }
			: { kind: "other", raw };
	});
}

export function writeEnv(lines: readonly EnvLine[]): string {
	return lines.map((line) => line.raw).join("\n");
}

export const varLine = (key: string, value: string): EnvLine => ({
	kind: "var",
	key,
	value,
	raw: `${key}=${value}`,
});

/** Last definition wins, like docker and dotenv. */
export function envMap(text: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of parseEnv(text)) {
		if (line.kind === "var") map.set(line.key, line.value);
	}
	return map;
}

export type EnvTexts = Record<EnvScope, string>;

/** Replace (or drop, with `next` null) the line at `index`. */
export function editLine(
	text: string,
	index: number,
	next: { key: string; value: string } | null,
): string {
	const lines = parseEnv(text);
	if (next === null) {
		lines.splice(index, 1);
	} else {
		lines[index] = varLine(next.key, next.value);
	}
	return writeEnv(lines);
}

/** Append `KEY=value`, without leaving a blank line before it. */
export function appendLine(text: string, key: string, value: string): string {
	const line = `${key}=${value}`;
	if (!text) return line;
	return text.endsWith("\n") ? `${text}${line}` : `${text}\n${line}`;
}

export type RowChange = "added" | "changed" | null;

export type EnvRow = {
	id: string;
	scope: EnvScope;
	index: number;
	key: string;
	value: string;
	change: RowChange;
};

export type RemovedRow = {
	id: string;
	scope: EnvScope;
	key: string;
	value: string;
};

/** The table: one row per defined key, plus what was removed since save. */
export function diffRows(
	draft: EnvTexts,
	saved: EnvTexts,
	scopes: readonly EnvScope[],
): { rows: EnvRow[]; removed: RemovedRow[]; changes: number } {
	const rows: EnvRow[] = [];
	const removed: RemovedRow[] = [];
	let changes = 0;
	for (const scope of scopes) {
		const before = envMap(saved[scope]);
		const seen = new Set<string>();
		parseEnv(draft[scope]).forEach((line, index) => {
			if (line.kind !== "var") return;
			const change: RowChange = !before.has(line.key)
				? "added"
				: before.get(line.key) !== line.value
					? "changed"
					: null;
			if (change && !seen.has(line.key)) changes++;
			seen.add(line.key);
			rows.push({
				id: `${scope}:${index}`,
				scope,
				index,
				key: line.key,
				value: line.value,
				change,
			});
		});
		for (const [key, value] of before) {
			if (seen.has(key)) continue;
			changes++;
			removed.push({ id: `${scope}:removed:${key}`, scope, key, value });
		}
	}
	return { rows, removed, changes };
}
