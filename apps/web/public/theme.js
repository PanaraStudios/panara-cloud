// Applies the saved theme before the first paint, as next-themes' inline
// script did (attribute "class", storage key "theme", default "system").
// A file rather than an inline script, so the Content-Security-Policy can
// refuse inline scripts.
(() => {
	const root = document.documentElement;
	let theme = "system";
	try {
		theme = localStorage.getItem("theme") || "system";
	} catch {}
	if (theme === "system") {
		theme = window.matchMedia("(prefers-color-scheme: dark)").matches
			? "dark"
			: "light";
	}
	root.classList.remove("light", "dark");
	root.classList.add(theme);
	if (theme === "light" || theme === "dark") root.style.colorScheme = theme;
})();
