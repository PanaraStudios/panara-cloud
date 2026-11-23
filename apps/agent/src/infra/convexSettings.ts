// Environment the panel's Convex backend runs with besides its addresses.
// The installer creates the service with all of it and an Update adds what an
// older install lacks. Only missing variables are added: one the
// administrator set by hand keeps its value, whatever it is.
//
// The FUNRUN_* names are Convex internals (crates/common/src/knobs.rs), read
// for the backend revision the installer pins (21f6fe42). Convex ignores a
// name it doesn't know and falls back to its default for a value it can't
// parse, so a later backend can't be broken by them.
export type ConvexSetting = {
	name: string;
	value: string;
	// Added again when present but empty, and forced by the installer on
	// every run, so it is not part of the installer's "add when missing" list.
	required?: boolean;
};

export const CONVEX_SETTINGS: ConvexSetting[] = [
	// Keeps stack traces out of the responses Convex gives clients.
	{ name: "REDACT_LOGS_TO_CLIENT", value: "true", required: true },
	// glibc otherwise gives every thread its own arena (up to 8 per core) and
	// never returns what a burst freed.
	{ name: "MALLOC_ARENA_MAX", value: "2" },
	// Seconds of document history kept. Convex's own docker-compose.yml sets
	// two days; the code default is 14.
	{ name: "DOCUMENT_RETENTION_DELAY", value: "172800" },
	// Any non-empty value stops the hourly report to api.convex.dev.
	{ name: "DISABLE_BEACON", value: "true" },
	// The image's default is /convex/data/tmp, on the data volume, where
	// directories left by a crash are never removed. The container's own /tmp
	// goes away with the container on every restart.
	{ name: "TMPDIR", value: "/tmp" },
	// Bytes. Bounds for the compiled-code and module-source caches, which are
	// sized for a multi-tenant cloud (500 MB and 250 MB). The panel's functions
	// are about 20 MB with their source maps, so three versions still fit.
	{ name: "FUNRUN_CODE_CACHE_SIZE", value: "64000000" },
	{ name: "FUNRUN_MODULE_CACHE_SIZE", value: "64000000" },
];

const envName = (entry: string) => entry.split("=", 1)[0] ?? "";

export const missingConvexSettings = (env: string[]): ConvexSetting[] =>
	CONVEX_SETTINGS.filter((setting) => {
		const entry = env.find((item) => envName(item) === setting.name);
		if (entry === undefined) return true;
		return setting.required === true && entry === `${setting.name}=`;
	});

// The line deploy/install.sh carries between its "generated convex settings"
// markers.
export const convexSettingsBlock = () =>
	`CONVEX_SETTINGS="${CONVEX_SETTINGS.filter((setting) => !setting.required)
		.map((setting) => `${setting.name}=${setting.value}`)
		.join(" ")}"\n`;
