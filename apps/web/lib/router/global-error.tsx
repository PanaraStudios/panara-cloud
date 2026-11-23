import { Component, type ComponentType, type ReactNode } from "react";
import type { ErrorBoundaryProps } from "./types";

// The last resort around the whole app, for an error in the root layout.
export class GlobalErrorBoundary extends Component<
	{ fallback: ComponentType<ErrorBoundaryProps>; children: ReactNode },
	{ error: Error | null }
> {
	state = { error: null as Error | null };
	static getDerivedStateFromError(error: unknown) {
		return { error: error instanceof Error ? error : new Error(String(error)) };
	}
	reset = () => this.setState({ error: null });
	render() {
		const Fallback = this.props.fallback;
		return this.state.error ? (
			<Fallback error={this.state.error} reset={this.reset} />
		) : (
			this.props.children
		);
	}
}
