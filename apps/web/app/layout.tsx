import { AppProviders } from "@/components/providers/theme";
import type { Metadata } from "@/lib/router";
import "./fonts.css";
import "./globals.css";

// The document itself (language, theme colours, icons, robots) is index.html.
export const metadata: Metadata = {
	title: { default: "Panara Cloud", template: "%s · Panara Cloud" },
};

export default function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return <AppProviders>{children}</AppProviders>;
}
