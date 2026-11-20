import { ImageResponse } from "next/og";

import {
	BRAND_VIOLET,
	LOGO_MARK_PATHS,
	LOGO_MARK_VIEWBOX,
} from "@/components/logo";

/* 180×180 PNG for iOS home screens. Matches app/icon.svg: the white mark on
   the violet tile. */

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
	return new ImageResponse(
		<div
			style={{
				width: "100%",
				height: "100%",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				background: BRAND_VIOLET,
				borderRadius: 40,
			}}
		>
			<svg width="71" height="124" viewBox={LOGO_MARK_VIEWBOX} fill="#ffffff">
				{LOGO_MARK_PATHS.map((d) => (
					<path key={d} d={d} />
				))}
			</svg>
		</div>,
		{ ...size },
	);
}
