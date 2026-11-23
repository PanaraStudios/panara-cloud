/** xterm.js colours for the light theme: its defaults are tuned for a black
    background, where bright yellow and white disappear on a light well. */
export const LIGHT_TERMINAL_COLORS = {
	black: "#171717",
	red: "#cf222e",
	green: "#116329",
	yellow: "#9a6700",
	blue: "#0969da",
	magenta: "#8250df",
	cyan: "#1b7c83",
	white: "#6e7781",
	brightBlack: "#57606a",
	brightRed: "#a40e26",
	brightGreen: "#1a7f37",
	brightYellow: "#7d4e00",
	brightBlue: "#218bff",
	brightMagenta: "#a475f9",
	brightCyan: "#3192aa",
	brightWhite: "#171717",
	selectionBackground: "rgba(0, 0, 0, 0.15)",
} as const;

export function terminalTheme(resolvedTheme: string | undefined) {
	const dark = resolvedTheme === "dark";
	return {
		cursor: dark ? "#e5e5e5" : "#171717",
		background: "rgba(0, 0, 0, 0)",
		foreground: dark ? "#f5f5f5" : "#171717",
		...(dark ? {} : LIGHT_TERMINAL_COLORS),
	};
}
