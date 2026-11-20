"use client";

import type React from "react";
import { useEffect, useRef, useState } from "react";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface Props extends React.HTMLAttributes<HTMLParagraphElement> {
	text: string;
}

export const TruncateTooltip = ({ text, className, ...props }: Props) => {
	const textRef = useRef<HTMLParagraphElement>(null);
	const [isTruncated, setIsTruncated] = useState(false);
	const [isOpen, setIsOpen] = useState(false);

	useEffect(() => {
		const element = textRef.current;
		if (!element) return;

		const checkTruncation = () => {
			const truncated = element.scrollWidth > element.clientWidth;
			setIsTruncated(truncated);
			if (!truncated) {
				setIsOpen(false);
			}
		};

		checkTruncation();

		const resizeObserver = new ResizeObserver(() => {
			checkTruncation();
		});

		resizeObserver.observe(element);

		return () => {
			resizeObserver.disconnect();
		};
	}, [text]);

	const content = (
		<p ref={textRef} className={cn("truncate", className)} {...props}>
			{text}
		</p>
	);

	return (
		<TooltipProvider>
			<Tooltip
				open={isOpen}
				onOpenChange={(open) => {
					// Only allow opening if it's actually truncated
					if (isTruncated) {
						setIsOpen(open);
					} else {
						setIsOpen(false);
					}
				}}
			>
				<TooltipTrigger render={content as React.ReactElement} />
				<TooltipContent
					side="bottom"
					align="start"
					className="max-w-[280px] break-words"
				>
					<p>{text}</p>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
};
