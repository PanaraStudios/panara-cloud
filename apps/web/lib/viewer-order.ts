export type ViewerOrder = "newest" | "oldest";

export interface DisplayOrder {
	/** The row (by its place in time order) shown at a place in the list. */
	toChrono: (display: number) => number;
	/** Where in the list a row is shown. */
	toDisplay: (chrono: number) => number;
}

const SAME: DisplayOrder = {
	toChrono: (index) => index,
	toDisplay: (index) => index,
};

/**
 * How rows kept in time order are laid out. Oldest first is the order they
 * are kept in. Newest first is that order turned over, row by row; a divider
 * (a build step's title) still sits above the rows of its section, so a
 * transcript reads "latest step, its lines from the newest down, then the
 * step before it".
 *
 * `dividers` are the places of the divider rows, ascending.
 */
export function displayOrder(
	count: number,
	order: ViewerOrder,
	dividers: readonly number[] = [],
): DisplayOrder {
	if (order === "oldest") return SAME;
	if (dividers.length === 0) {
		const flip = (index: number) => count - 1 - index;
		return { toChrono: flip, toDisplay: flip };
	}
	/** Index of the divider whose section holds `chrono`, or -1 before the first. */
	const sectionOf = (chrono: number) => {
		let low = 0;
		let high = dividers.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((dividers[middle] as number) <= chrono) low = middle + 1;
			else high = middle;
		}
		return low - 1;
	};
	const endOf = (section: number) =>
		section + 1 < dividers.length ? (dividers[section + 1] as number) : count;
	return {
		toChrono: (display) => {
			const turned = count - 1 - display;
			const section = sectionOf(turned);
			if (section === -1) return turned;
			// A section takes the places its rows had; its title moves from the
			// last of them to the first.
			const first = count - endOf(section);
			return display === first ? (dividers[section] as number) : turned + 1;
		},
		toDisplay: (chrono) => {
			const section = sectionOf(chrono);
			if (section === -1) return count - 1 - chrono;
			return chrono === dividers[section]
				? count - endOf(section)
				: count - chrono;
		},
	};
}

const KEY = "panara-cloud:viewer-order:";

/** The order last chosen for a kind of list on this device. */
export function readOrder(kind: string): ViewerOrder {
	try {
		return localStorage.getItem(KEY + kind) === "oldest" ? "oldest" : "newest";
	} catch {
		return "newest";
	}
}

export function writeOrder(kind: string, order: ViewerOrder) {
	try {
		if (order === "newest") localStorage.removeItem(KEY + kind);
		else localStorage.setItem(KEY + kind, order);
	} catch {
		// Private windows and blocked storage: the choice lasts for the page.
	}
}

/**
 * How many rows wait behind a paused tail, as the heading's button says it:
 * the number itself below ten thousand, then in thousands. `badge` is the
 * short form for the button that has room only for its icon.
 */
export function waitingCount(count: number): { text: string; badge: string } {
	return {
		text:
			count >= 10_000
				? `${(count / 1000).toFixed(1)}k`
				: count.toLocaleString("en-US"),
		badge: count > 99 ? "99+" : String(count),
	};
}
