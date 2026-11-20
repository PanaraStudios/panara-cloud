// Watch-path matching with micromatch's default semantics (micromatch
// itself isn't available in the Convex runtime): `*`, `?`, `**`,
// character classes, `{a,b}` braces, `!` negation, and wildcards don't match
// dotfiles unless the pattern names the dot. Extglobs (`+(a|b)`) and numeric
// brace ranges are not supported and match literally.

const MAX_EXPANSIONS = 256;
const MAX_PATTERN_LENGTH = 1024;

const expandBraces = (pattern: string): string[] => {
	let depth = 0;
	let start = -1;
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "\\") {
			i++;
			continue;
		}
		if (char === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (char === "}" && depth > 0) {
			depth--;
			if (depth === 0) {
				const body = pattern.slice(start + 1, i);
				const options: string[] = [];
				let level = 0;
				let last = 0;
				for (let j = 0; j < body.length; j++) {
					if (body[j] === "\\") j++;
					else if (body[j] === "{") level++;
					else if (body[j] === "}") level--;
					else if (body[j] === "," && level === 0) {
						options.push(body.slice(last, j));
						last = j + 1;
					}
				}
				options.push(body.slice(last));
				if (options.length < 2) continue;
				const prefix = pattern.slice(0, start);
				const suffix = pattern.slice(i + 1);
				const result: string[] = [];
				for (const option of options) {
					for (const expanded of expandBraces(prefix + option + suffix)) {
						result.push(expanded);
						if (result.length >= MAX_EXPANSIONS) return result;
					}
				}
				return result;
			}
		}
	}
	return [pattern];
};

const escapeRegex = (char: string) =>
	char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const segmentSource = (segment: string): string => {
	if (segment === "*") return "(?!\\.)[^/]+";
	let source = "";
	for (let i = 0; i < segment.length; i++) {
		const char = segment[i] as string;
		if (char === "\\" && i + 1 < segment.length) {
			source += escapeRegex(segment[++i] as string);
		} else if (char === "*") {
			while (segment[i + 1] === "*") i++;
			source += "[^/]*";
		} else if (char === "?") {
			source += "[^/]";
		} else if (char === "[") {
			const end = segment.indexOf("]", i + 2);
			if (end === -1) {
				source += "\\[";
				continue;
			}
			let body = segment.slice(i + 1, end);
			const negated = body.startsWith("!") || body.startsWith("^");
			if (negated) body = body.slice(1);
			source += `[${negated ? "^/" : ""}${body.replace(/\\/g, "\\\\").replace(/]/g, "\\]")}]`;
			i = end;
		} else {
			source += escapeRegex(char);
		}
	}
	// Wildcards at the start of a segment never match a leading dot.
	return /^[*?[]/.test(segment) ? `(?!\\.)${source}` : source;
};

const globSource = (pattern: string): string => {
	const segments = pattern.split("/");
	let source = "";
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i] as string;
		const isLast = i === segments.length - 1;
		if (segment === "**") {
			if (isLast) {
				// "a/**" matches "a" and everything below it.
				source =
					i === 0
						? "(?:(?!\\.)[^/]+(?:/(?!\\.)[^/]+)*)?"
						: `${source.replace(/\/$/, "")}(?:/(?!\\.)[^/]+)*`;
			} else {
				source += "(?:(?!\\.)[^/]+/)*";
			}
			continue;
		}
		source += segmentSource(segment);
		if (!isLast) source += "/";
	}
	return source;
};

const compiled = new Map<string, RegExp[]>();

const compile = (pattern: string): RegExp[] => {
	let regexes = compiled.get(pattern);
	if (!regexes) {
		const normalized = pattern.replace(/^\.\//, "");
		regexes = expandBraces(normalized).map(
			(expanded) => new RegExp(`^${globSource(expanded)}$`),
		);
		if (compiled.size > 1000) compiled.clear();
		compiled.set(pattern, regexes);
	}
	return regexes;
};

export const isGlobMatch = (file: string, pattern: string): boolean =>
	pattern.length <= MAX_PATTERN_LENGTH &&
	compile(pattern).some((regex) => regex.test(file.replace(/^\.\//, "")));

// micromatch(files, patterns).length > 0 semantics: a file counts when it
// matches a positive pattern (or there are only negations) and no negation.
export const matchesAny = (files: string[], patterns: string[]): boolean => {
	const positive: string[] = [];
	const negative: string[] = [];
	for (const pattern of patterns) {
		if (pattern.startsWith("!") && !pattern.startsWith("!(")) {
			negative.push(pattern.slice(1));
		} else {
			positive.push(pattern);
		}
	}
	return files.some(
		(file) =>
			(positive.length === 0 || positive.some((p) => isGlobMatch(file, p))) &&
			!negative.some((p) => isGlobMatch(file, p)),
	);
};

// No watch paths means every push deploys; a push
// whose changed files are unknown (null) deploys too.
export const shouldDeploy = (
	watchPaths: string[] | null | undefined,
	changedFiles: string[] | null | undefined,
): boolean => {
	if (!watchPaths || watchPaths.length === 0) return true;
	if (changedFiles === null) return true;
	return matchesAny(changedFiles ?? [], watchPaths);
};
