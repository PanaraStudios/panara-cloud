"use client";

import { ThemeProvider } from "next-themes";
import { ProgressProvider } from "@/components/progress-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

// opensend's root providers: theme → route progress → tooltips. Panara Cloud
// keeps sonner for toasts, styled like opensend's (see components/ui/sonner).
export function AppProviders({ children }: { children: React.ReactNode }) {
	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="system"
			enableSystem
			disableTransitionOnChange
		>
			<ProgressProvider>
				<TooltipProvider>
					{children}
					<Toaster />
				</TooltipProvider>
			</ProgressProvider>
		</ThemeProvider>
	);
}
