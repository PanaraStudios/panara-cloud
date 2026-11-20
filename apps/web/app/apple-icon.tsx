import { ImageResponse } from "next/og";

import { LOGO_MARK_PATH, LOGO_MARK_STROKE } from "@/components/logo";

/* 180×180 PNG for iOS home screens. Matches app/icon.svg: dark rounded
   square, white cloud mark (opensend's icon treatment). */

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
				background: "#171717",
				borderRadius: 40,
			}}
		>
			<svg width="112" height="112" viewBox="0 0 24 24" fill="none">
				<path
					d={LOGO_MARK_PATH}
					stroke="#ffffff"
					strokeWidth={LOGO_MARK_STROKE}
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
		</div>,
		{ ...size },
	);
}
