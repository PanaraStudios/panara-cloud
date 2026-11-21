"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import {
	LOADER_STILL_MS,
	LOADER_VIEWBOX,
	loaderFrame,
} from "./logo-loader-scene";

/** The panel's loading sign: cubes that stack into a "P" and then spell
    P A N A R A one letter at a time (see `logo-loader-scene`). With reduced
    motion the finished "P" is shown and nothing moves. */
export function LogoLoader({
	className,
	label = "Loading",
}: {
	className?: string;
	label?: string;
}) {
	const scene = useRef<SVGGElement>(null);
	useEffect(() => {
		const group = scene.current;
		if (!group) return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			group.innerHTML = loaderFrame(LOADER_STILL_MS);
			return;
		}
		const start = performance.now();
		let frame = requestAnimationFrame(function draw(now) {
			group.innerHTML = loaderFrame(now - start);
			frame = requestAnimationFrame(draw);
		});
		return () => cancelAnimationFrame(frame);
	}, []);
	return (
		<div role="status" className={cn("inline-flex", className)}>
			<svg
				viewBox={LOADER_VIEWBOX}
				xmlns="http://www.w3.org/2000/svg"
				aria-hidden
				strokeLinejoin="round"
				// The three tones of a cube. The left face, where the letter reads, is
				// the lightest.
				className="block h-44 w-auto overflow-visible [--cube-left:#8f69cf] [--cube-right:#4a2d75] [--cube-top:#623e96] dark:[--cube-left:#b79cf0] dark:[--cube-right:#553382] dark:[--cube-top:#7a52b8]"
			>
				<g ref={scene} />
			</svg>
			<span className="sr-only">{label}</span>
		</div>
	);
}
