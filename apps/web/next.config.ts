import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	// The production image runs the standalone server; tracing from the
	// workspace root picks up @panara-cloud/backend's generated API.
	output: "standalone",
	outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
	// Nothing uses next/image, so /_next/image is off. Next still traces its
	// optional sharp dependency (about 19 MB) into the standalone output
	// whenever it is installed. Exclude globs are resolved from this directory,
	// so "../.." is the tracing root, where pnpm keeps the packages.
	images: { unoptimized: true },
	outputFileTracingExcludes: {
		"*": [
			"../../**/node_modules/sharp/**/*",
			"../../**/node_modules/@img/**/*",
		],
	},
	poweredByHeader: false,
	reactStrictMode: true,
	// The sidebar's account button sits in the bottom-left corner.
	devIndicators: { position: "bottom-right" },
	async headers() {
		return [
			{
				source: "/:path*",
				headers: [
					{ key: "X-Frame-Options", value: "DENY" },
					{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
					{ key: "X-Content-Type-Options", value: "nosniff" },
				],
			},
		];
	},
};

export default nextConfig;
