import { cn } from "@/lib/utils";

export type LogoVariant = "full" | "mark";
export type LogoTheme = "auto" | "brand" | "light" | "dark";

export type LogoProps = {
	className?: string;
	/** `full` is the mark + "Panara Cloud" lockup. `mark` is the mark alone. */
	variant?: LogoVariant;
	/**
	 * `brand` is the mark's own violet. `auto` follows the page ink via
	 * `currentColor`. `light` / `dark` force ink for a known background.
	 */
	theme?: LogoTheme;
};

export const BRAND_VIOLET = "#623E96";

const themeClass = {
	auto: "text-foreground",
	// A lighter tint on dark pages, where the violet itself is too dim.
	brand: "text-[#623E96] dark:text-[#8f69cf]",
	light: "text-black",
	dark: "text-white",
} as const;

/* The isometric "P": a cube top, the stem and the two faces of the bowl,
   from the owner's drawing. The view box is cropped to the drawing, which is
   taller than wide (742 × 1292). */
export const LOGO_MARK_VIEWBOX = "609 280 742 1292";
export const LOGO_MARK_PATHS = [
	"M609.533 505.397C622.526 512.087 638.608 521.961 651.504 529.413L727.467 573.202 970.163 713.176 972.063 1571.383 609.445 1361.493 609.533 505.397z",
	"M981.533 280.773C987.583 282.205 1052.663 321.429 1063.873 327.921L1341.823 488.85C1303.233 511.941 1263.093 534.679 1224.153 557.318L981.523 698.465C980.153 698.817 979.033 698.406 977.893 697.739 941.593 676.584 905.198 655.273 868.942 634.076L620.386 488.919 981.533 280.773z",
	"M1349.313 506.831L1350.203 507.354C1351.583 511.269 1350.713 590.368 1350.713 599.163L1350.773 914.113C1277.903 873.286 1203.543 828.956 1131.053 787.02L997.943 710.103 1349.313 506.831z",
	"M989.133 723.506C1003.213 731.268 1017.383 739.701 1031.233 747.931 1134.223 809.11 1239.043 867.781 1341.723 929.403 1328.203 936.373 1311.473 946.553 1298.003 954.273L1213.623 1002.743C1189.043 1016.123 1162.993 1031.733 1138.603 1045.713L989.083 1131.473 989.133 723.506z",
] as const;

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
			className={cn(
				"block h-[1em] w-auto shrink-0",
				themeClass[theme],
				className,
			)}
			fill="currentColor"
			role={decorative ? "presentation" : "img"}
			aria-hidden={decorative ? true : undefined}
			aria-label={decorative ? undefined : "Panara Cloud"}
		>
			{decorative ? null : <title>Panara Cloud</title>}
			{LOGO_MARK_PATHS.map((d) => (
				<path key={d} d={d} />
			))}
		</svg>
	);
}

/** The violet mark centred in a square slot, so it lines up with the icons
    and avatars around it. Size follows `className`. */
export function BrandMark({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				"inline-flex size-7 shrink-0 items-center justify-center",
				className,
			)}
		>
			{/* `!`: sidebar buttons size every svg inside them to 16px. */}
			<LogoMark decorative theme="brand" className="h-[92%]! w-auto!" />
		</span>
	);
}

/**
 * Panara Cloud lockup: the mark alone, or the violet mark + "Panara Cloud"
 * in the page ink. Size follows `em` (`text-base`, `text-lg`, …).
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
				"inline-flex items-center gap-[0.4em] font-sans font-semibold tracking-tight",
				themeClass[theme === "brand" ? "auto" : theme],
				className,
			)}
		>
			<LogoMark
				theme={theme === "auto" ? "brand" : theme}
				decorative
				className="h-[1.45em]"
			/>
			<span className="leading-none">Panara Cloud</span>
		</span>
	);
}
