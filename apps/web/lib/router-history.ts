type HistoryMethod = History["pushState"];

/**
 * Next.js keeps `usePathname` and `useSearchParams` in step with
 * `window.history.pushState` / `replaceState` called by app code (the
 * settings sections change the URL that way so the open form is not
 * remounted). This wraps both methods so the router hears about such calls,
 * and returns the unwrapped ones for the router's own navigations.
 */
export function followHistoryCalls(
	history: Pick<History, "pushState" | "replaceState">,
	onChange: () => void,
): { push: HistoryMethod; replace: HistoryMethod } {
	const push = history.pushState.bind(history);
	const replace = history.replaceState.bind(history);
	history.pushState = (data, unused, url) => {
		push(data, unused, url);
		if (url != null) onChange();
	};
	history.replaceState = (data, unused, url) => {
		replace(data, unused, url);
		if (url != null) onChange();
	};
	return { push, replace };
}
