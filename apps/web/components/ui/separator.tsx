"use client";

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
import { cn } from "cn";

const SIZED = /(^|\s)(h|size)-/;

function Separator({
	className,
	orientation = "horizontal",
	...props
}: SeparatorPrimitive.Props) {
	return (
		<SeparatorPrimitive
			data-slot="separator"
			orientation={orientation}
			className={cn(
				"shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px",
				// A stretched flex item with a set height sits at the top of its
				// row, so a vertical rule that is given a height is centred instead.
				orientation === "vertical" &&
					(SIZED.test(typeof className === "string" ? className : "")
						? "self-center"
						: "self-stretch"),
				className,
			)}
			{...props}
		/>
	);
}

export { Separator };
