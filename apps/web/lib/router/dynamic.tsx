import { type ComponentType, lazy, type ReactNode, Suspense } from "react";

type Loaded<P> = ComponentType<P> | { default: ComponentType<P> };

// next/dynamic for a client build: the component loads with its own chunk
// the first time it renders, showing `loading` until then.
export default function dynamic<P extends object>(
	load: () => Promise<Loaded<P>>,
	options: { ssr?: boolean; loading?: () => ReactNode } = {},
): ComponentType<P> {
	const Lazy = lazy(async () => {
		const loaded = await load();
		return { default: "default" in loaded ? loaded.default : loaded };
	});
	const Loading = options.loading;
	function Dynamic(props: P) {
		return (
			<Suspense fallback={Loading ? <Loading /> : null}>
				<Lazy {...props} />
			</Suspense>
		);
	}
	return Dynamic;
}
