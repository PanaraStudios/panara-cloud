import type { AnchorHTMLAttributes, MouseEvent, Ref } from "react";
import { navigate, prefetch } from "./store";

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
	href: string;
	replace?: boolean;
	scroll?: boolean;
	prefetch?: boolean | null;
	ref?: Ref<HTMLAnchorElement>;
};

// Left clicks without modifier keys on same-origin links navigate in the
// page; anything else (new tab, download, another site) is a plain link.
const handledHere = (
	event: MouseEvent<HTMLAnchorElement>,
	href: string,
	target: string | undefined,
	download: unknown,
) => {
	if (event.defaultPrevented || event.button !== 0) return false;
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
		return false;
	}
	if ((target && target !== "_self") || download !== undefined) return false;
	return new URL(href, window.location.href).origin === window.location.origin;
};

export default function Link({
	href,
	replace,
	scroll,
	prefetch: shouldPrefetch,
	onClick,
	onMouseEnter,
	onTouchStart,
	onFocus,
	...rest
}: LinkProps) {
	const warm = () => {
		if (shouldPrefetch !== false) prefetch(href);
	};
	return (
		<a
			{...rest}
			href={href}
			onClick={(event) => {
				onClick?.(event);
				if (!handledHere(event, href, rest.target, rest.download)) return;
				event.preventDefault();
				void navigate(href, { replace, scroll });
			}}
			onMouseEnter={(event) => {
				onMouseEnter?.(event);
				warm();
			}}
			onTouchStart={(event) => {
				onTouchStart?.(event);
				warm();
			}}
			onFocus={(event) => {
				onFocus?.(event);
				warm();
			}}
		/>
	);
}
