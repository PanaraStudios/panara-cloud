// Entry of the agent image's `migrate` (docker/entrypoint.sh): prints the
// directory of the fetched deploy files on stdout, everything else on stderr.
import { fetchMigrateFiles } from "./fetch";

try {
	process.stdout.write(`${await fetchMigrateFiles()}\n`);
} catch (error) {
	console.error(
		`[migrate] ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
}
