import type { Metadata, Viewport } from "next";
import { AppProviders } from "@/components/providers/theme";
import { fontClassName } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
	title: { default: "Panara Cloud", template: "%s · Panara Cloud" },
	applicationName: "Panara Cloud",
	robots: { index: false, follow: false },
};

/* Matches the page background so the browser chrome blends in on mobile. */
export const viewport: Viewport = {
	themeColor: [
		{ media: "(prefers-color-scheme: light)", color: "#fafafa" },
		{ media: "(prefers-color-scheme: dark)", color: "#000000" },
	],
};

export default function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return (
		<html
			lang="en"
			suppressHydrationWarning
			data-scroll-behavior="smooth"
			className={fontClassName}
		>
			<body>
				<AppProviders>{children}</AppProviders>
			</body>
		</html>
	);
}
