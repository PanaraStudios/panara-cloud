// A TOML 1.0 parser for template.toml files. The backend has no TOML
// dependency (the agent's `toml` package isn't available to Convex), so this
// covers the full value grammar; dates and times are returned as strings.

export type TomlValue =
	| string
	| number
	| boolean
	| TomlValue[]
	| { [key: string]: TomlValue };
type TomlTable = { [key: string]: TomlValue };

export class TomlError extends Error {
	constructor(message: string, line: number) {
		super(`${message} (line ${line})`);
	}
}

const BARE_KEY = /[A-Za-z0-9_-]/;
const DATE_TIME =
	/^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?|^\d{2}:\d{2}:\d{2}(\.\d+)?/;

// Tracks how each table was created so redefinitions are rejected.
const explicitTables = new WeakSet<object>();
const arrayTables = new WeakSet<object>();
const inlineTables = new WeakSet<object>();

class Parser {
	private pos = 0;
	private line = 1;

	constructor(private readonly src: string) {}

	private fail(message: string): never {
		throw new TomlError(message, this.line);
	}

	private peek(offset = 0): string {
		return this.src[this.pos + offset] ?? "";
	}

	private startsWith(text: string): boolean {
		return this.src.startsWith(text, this.pos);
	}

	private advance(count = 1) {
		for (let i = 0; i < count; i++) {
			if (this.src[this.pos] === "\n") this.line++;
			this.pos++;
		}
	}

	private skipWhitespace() {
		while (this.peek() === " " || this.peek() === "\t") this.advance();
	}

	private skipComment() {
		if (this.peek() !== "#") return;
		while (this.pos < this.src.length && this.peek() !== "\n") this.advance();
	}

	private skipWhitespaceCommentsAndNewlines() {
		for (;;) {
			this.skipWhitespace();
			this.skipComment();
			if (this.peek() === "\n") this.advance();
			else if (this.startsWith("\r\n")) this.advance(2);
			else return;
		}
	}

	private expectLineEnd() {
		this.skipWhitespace();
		this.skipComment();
		if (this.pos >= this.src.length) return;
		if (this.peek() === "\n") return this.advance();
		if (this.startsWith("\r\n")) return this.advance(2);
		this.fail(`Unexpected "${this.peek()}"`);
	}

	parse(): TomlTable {
		const root: TomlTable = {};
		let current = root;
		for (;;) {
			this.skipWhitespaceCommentsAndNewlines();
			if (this.pos >= this.src.length) return root;
			if (this.startsWith("[[")) {
				this.advance(2);
				const path = this.parseKey("]]");
				this.advance(2);
				current = this.openArrayTable(root, path);
			} else if (this.peek() === "[") {
				this.advance();
				const path = this.parseKey("]");
				this.advance();
				current = this.openTable(root, path);
			} else {
				const path = this.parseKey("=");
				this.advance();
				this.skipWhitespace();
				this.assign(current, path, this.parseValue());
			}
			this.expectLineEnd();
		}
	}

	private parseKey(terminator: string): string[] {
		const parts: string[] = [];
		for (;;) {
			this.skipWhitespace();
			if (this.peek() === '"') parts.push(this.parseBasicString());
			else if (this.peek() === "'") parts.push(this.parseLiteralString());
			else {
				let key = "";
				while (BARE_KEY.test(this.peek())) {
					key += this.peek();
					this.advance();
				}
				if (!key) this.fail("Expected a key");
				parts.push(key);
			}
			this.skipWhitespace();
			if (this.peek() === ".") {
				this.advance();
				continue;
			}
			if (!this.startsWith(terminator)) this.fail(`Expected "${terminator}"`);
			return parts;
		}
	}

	private descend(table: TomlTable, key: string, implicit: boolean): TomlTable {
		const existing = table[key];
		if (existing === undefined) {
			const created: TomlTable = {};
			table[key] = created;
			return created;
		}
		if (Array.isArray(existing)) {
			if (!arrayTables.has(existing)) this.fail(`"${key}" is not a table`);
			return existing[existing.length - 1] as TomlTable;
		}
		if (typeof existing !== "object" || inlineTables.has(existing)) {
			this.fail(`"${key}" is already defined`);
		}
		if (!implicit && explicitTables.has(existing)) {
			this.fail(`Table "${key}" is defined twice`);
		}
		return existing as TomlTable;
	}

	private openTable(root: TomlTable, path: string[]): TomlTable {
		let table = root;
		path.forEach((key, index) => {
			table = this.descend(table, key, index < path.length - 1);
		});
		explicitTables.add(table);
		return table;
	}

	private openArrayTable(root: TomlTable, path: string[]): TomlTable {
		let table = root;
		for (const key of path.slice(0, -1)) table = this.descend(table, key, true);
		const last = path[path.length - 1];
		let list = table[last];
		if (list === undefined) {
			list = [];
			arrayTables.add(list);
			table[last] = list;
		} else if (!Array.isArray(list) || !arrayTables.has(list)) {
			this.fail(`"${last}" is not an array of tables`);
		}
		const entry: TomlTable = {};
		(list as TomlValue[]).push(entry);
		return entry;
	}

	private assign(table: TomlTable, path: string[], value: TomlValue) {
		let target = table;
		for (const key of path.slice(0, -1)) {
			const existing = target[key];
			if (existing === undefined) {
				const created: TomlTable = {};
				target[key] = created;
				target = created;
			} else if (
				typeof existing === "object" &&
				!Array.isArray(existing) &&
				!inlineTables.has(existing) &&
				!explicitTables.has(existing)
			) {
				target = existing as TomlTable;
			} else {
				this.fail(`"${key}" is already defined`);
			}
		}
		const last = path[path.length - 1];
		if (last in target) this.fail(`"${last}" is defined twice`);
		target[last] = value;
	}

	private parseValue(): TomlValue {
		const char = this.peek();
		if (char === '"') {
			return this.startsWith('"""')
				? this.parseMultilineBasicString()
				: this.parseBasicString();
		}
		if (char === "'") {
			return this.startsWith("'''")
				? this.parseMultilineLiteralString()
				: this.parseLiteralString();
		}
		if (char === "[") return this.parseArray();
		if (char === "{") return this.parseInlineTable();
		if (this.startsWith("true")) {
			this.advance(4);
			return true;
		}
		if (this.startsWith("false")) {
			this.advance(5);
			return false;
		}
		const rest = this.src.slice(this.pos);
		const date = DATE_TIME.exec(rest);
		if (date) {
			this.advance(date[0].length);
			return date[0];
		}
		return this.parseNumber();
	}

	private parseNumber(): number {
		const match = /^[+-]?[0-9A-Za-z_.+-]+/.exec(this.src.slice(this.pos));
		if (!match) this.fail("Expected a value");
		const raw = match[0];
		this.advance(raw.length);
		if (/^[+-]?inf$/.test(raw))
			return raw.startsWith("-")
				? Number.NEGATIVE_INFINITY
				: Number.POSITIVE_INFINITY;
		if (/^[+-]?nan$/.test(raw)) return Number.NaN;
		if (raw.includes("__") || /(^|[^0-9a-fA-F])_|_($|[^0-9a-fA-F])/.test(raw)) {
			this.fail(`Invalid number "${raw}"`);
		}
		const clean = raw.replaceAll("_", "");
		let value: number;
		if (/^0x[0-9a-fA-F]+$/.test(clean))
			value = Number.parseInt(clean.slice(2), 16);
		else if (/^0o[0-7]+$/.test(clean))
			value = Number.parseInt(clean.slice(2), 8);
		else if (/^0b[01]+$/.test(clean))
			value = Number.parseInt(clean.slice(2), 2);
		else if (/^[+-]?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(clean)) {
			value = Number(clean);
		} else this.fail(`Invalid value "${raw}"`);
		return value;
	}

	private parseEscape(): string {
		this.advance();
		const char = this.peek();
		const simple: Record<string, string> = {
			b: "\b",
			t: "\t",
			n: "\n",
			f: "\f",
			r: "\r",
			e: "\u001b",
			'"': '"',
			"\\": "\\",
		};
		if (char in simple) {
			this.advance();
			return simple[char];
		}
		const length = char === "u" ? 4 : char === "U" ? 8 : char === "x" ? 2 : 0;
		if (!length) this.fail(`Invalid escape "\\${char}"`);
		const hex = this.src.slice(this.pos + 1, this.pos + 1 + length);
		if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== length) {
			this.fail("Invalid unicode escape");
		}
		this.advance(length + 1);
		return String.fromCodePoint(Number.parseInt(hex, 16));
	}

	private parseBasicString(): string {
		this.advance();
		let out = "";
		for (;;) {
			const char = this.peek();
			if (!char || char === "\n") this.fail("Unterminated string");
			if (char === '"') {
				this.advance();
				return out;
			}
			if (char === "\\") out += this.parseEscape();
			else {
				out += char;
				this.advance();
			}
		}
	}

	private parseLiteralString(): string {
		this.advance();
		const end = this.src.indexOf("'", this.pos);
		const newline = this.src.indexOf("\n", this.pos);
		if (end === -1 || (newline !== -1 && newline < end)) {
			this.fail("Unterminated string");
		}
		const value = this.src.slice(this.pos, end);
		this.advance(end - this.pos + 1);
		return value;
	}

	private skipLeadingNewline() {
		if (this.peek() === "\n") this.advance();
		else if (this.startsWith("\r\n")) this.advance(2);
	}

	// Up to two quotes may directly precede the closing delimiter.
	private closingQuotes(quote: string): number {
		let count = 0;
		while (this.peek(count) === quote) count++;
		return count >= 3 ? Math.min(count, 5) : 0;
	}

	private parseMultilineBasicString(): string {
		this.advance(3);
		this.skipLeadingNewline();
		let out = "";
		for (;;) {
			if (this.pos >= this.src.length) this.fail("Unterminated string");
			const quotes = this.closingQuotes('"');
			if (quotes) {
				out += '"'.repeat(quotes - 3);
				this.advance(quotes);
				return out;
			}
			if (this.peek() === "\\") {
				const after = /^\\[ \t]*\r?\n/.exec(this.src.slice(this.pos));
				if (after) {
					this.advance(after[0].length);
					while (/[ \t\r\n]/.test(this.peek()) && this.peek()) this.advance();
					continue;
				}
				out += this.parseEscape();
				continue;
			}
			out += this.peek();
			this.advance();
		}
	}

	private parseMultilineLiteralString(): string {
		this.advance(3);
		this.skipLeadingNewline();
		let out = "";
		for (;;) {
			if (this.pos >= this.src.length) this.fail("Unterminated string");
			const quotes = this.closingQuotes("'");
			if (quotes) {
				out += "'".repeat(quotes - 3);
				this.advance(quotes);
				return out;
			}
			out += this.peek();
			this.advance();
		}
	}

	private parseArray(): TomlValue[] {
		this.advance();
		const items: TomlValue[] = [];
		for (;;) {
			this.skipWhitespaceCommentsAndNewlines();
			if (this.peek() === "]") {
				this.advance();
				return items;
			}
			items.push(this.parseValue());
			this.skipWhitespaceCommentsAndNewlines();
			if (this.peek() === ",") this.advance();
			else if (this.peek() !== "]") this.fail('Expected "," or "]"');
		}
	}

	private parseInlineTable(): TomlTable {
		this.advance();
		const table: TomlTable = {};
		inlineTables.add(table);
		this.skipWhitespace();
		if (this.peek() === "}") {
			this.advance();
			return table;
		}
		for (;;) {
			const path = this.parseKey("=");
			this.advance();
			this.skipWhitespace();
			this.assign(table, path, this.parseValue());
			this.skipWhitespace();
			if (this.peek() === "}") {
				this.advance();
				return table;
			}
			if (this.peek() !== ",") this.fail('Expected "," or "}"');
			this.advance();
			this.skipWhitespace();
		}
	}
}

export const parseToml = (source: string): TomlTable =>
	new Parser(source.replace(/^﻿/, "")).parse();
