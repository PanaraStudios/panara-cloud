import { isValidElement, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Whether a caller-supplied trigger element renders a native `<button>`.
 * Base UI triggers need `nativeButton={false}` when they render anything else
 * (a DropdownMenuItem, a div); Radix's `asChild` didn't care.
 */
export function rendersNativeButton(node: ReactNode) {
	return (
		isValidElement(node) &&
		(node.type === Button ||
			node.type === TooltipTrigger ||
			node.type === "button")
	);
}

/**
 * A dialog trigger rendering a menu item gives it `role="button"`, which
 * hides it from menu keyboard navigation and assistive tech; keep the item's
 * own role.
 */
export function triggerRole(node: ReactNode) {
	return isValidElement(node) &&
		(node.type === DropdownMenuItem || node.type === ContextMenuItem)
		? "menuitem"
		: undefined;
}
