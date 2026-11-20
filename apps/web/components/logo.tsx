import { cn } from "@/lib/utils";

export type LogoVariant = "full" | "mark";
export type LogoTheme = "auto" | "light" | "dark";

export type LogoProps = {
	className?: string;
	/** `full` is the cloud + "Panara Cloud" lockup. `mark` is the cloud alone. */
	variant?: LogoVariant;
	/**
	 * `auto` follows the page theme via `currentColor`.
	 * `light` / `dark` force ink for a known background (icons, dark panels).
	 */
	theme?: LogoTheme;
};

const themeClass = {
	auto: "text-foreground",
	light: "text-black",
	dark: "text-white",
} as const;

/* Open-line cloud in a 24×24 viewBox, round caps (opensend's mark weight). */
export const LOGO_MARK_VIEWBOX = "0 0 24 24";
export const LOGO_MARK_STROKE = 2.2;
export const LOGO_MARK_PATH =
	"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z";

export function LogoMark({
	className,
	theme = "auto",
	decorative = false,
}: {
	className?: string;
	theme?: LogoTheme;
	/** Hide from AT when the wordmark sits beside it. */
	decorative?: boolean;
}) {
	return (
		<svg
			viewBox={LOGO_MARK_VIEWBOX}
			xmlns="http://www.w3.org/2000/svg"
			className={cn("block size-[1em] shrink-0", themeClass[theme], className)}
			role={decorative ? "presentation" : "img"}
			aria-hidden={decorative ? true : undefined}
			aria-label={decorative ? undefined : "Panara Cloud"}
		>
			{decorative ? null : <title>Panara Cloud</title>}
			<path
				d={LOGO_MARK_PATH}
				fill="none"
				stroke="currentColor"
				strokeWidth={LOGO_MARK_STROKE}
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** The mark on Panara Cloud's violet tile: the one place the brand colour
    shows (owner: monochrome everywhere else). Size follows `className`. */
export function LogoTile({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				"inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-linear-to-b from-[#8b5cf6] to-[#7c3aed] shadow-[inset_0_1px_0_rgb(255_255_255/0.25)]",
				className,
			)}
		>
			<LogoMark decorative theme="dark" className="size-[55%]" />
		</span>
	);
}

/**
 * Panara Cloud lockup: the cloud mark, or cloud + "Panara Cloud".
 * Size follows `em` (`text-base`, `text-lg`, …). Ink follows theme.
 */
export function Logo({
	className,
	variant = "full",
	theme = "auto",
}: LogoProps) {
	if (variant === "mark") {
		return <LogoMark className={className} theme={theme} />;
	}

	return (
		<span
			className={cn(
				"inline-flex items-center gap-[0.32em] font-sans font-semibold tracking-tight",
				themeClass[theme],
				className,
			)}
		>
			<LogoMark theme={theme} decorative className="size-[1.22em]" />
			<span className="leading-none">Panara Cloud</span>
		</span>
	);
}
