import type { ComponentType, ReactNode } from "react";

// The parts of Next.js's metadata the app sets.
export type Metadata = {
	title?: string | { default?: string; template?: string; absolute?: string };
	robots?: { index?: boolean; follow?: boolean };
	applicationName?: string;
};

export type ErrorBoundaryProps = {
	error: Error & { digest?: string };
	reset: () => void;
};

export type RouteModule = {
	default: ComponentType<{ children?: ReactNode }>;
	metadata?: Metadata;
};
