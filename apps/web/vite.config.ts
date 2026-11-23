import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { devServer, fontPreloads, routePreloads } from "./dev-server";

export default defineConfig({
	plugins: [
		react(),
		tailwindcss(),
		devServer(),
		fontPreloads(),
		routePreloads(),
	],
	resolve: {
		alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
	},
	server: { port: 3000, strictPort: true },
	preview: { port: 3000, strictPort: true },
	build: {
		outDir: "dist",
		// The files are served precompressed; a source map would publish the
		// sources next to them.
		sourcemap: false,
		chunkSizeWarningLimit: 2048,
		rollupOptions: {
			// Many pages share small modules; without a floor Rollup makes a
			// chunk of each, and a page load becomes a hundred requests.
			output: { experimentalMinChunkSize: 20_000 },
			onwarn(warning, warn) {
				// Components keep Next.js's "use client" markers, which mean
				// nothing in a client build.
				if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
				warn(warning);
			},
		},
	},
});
