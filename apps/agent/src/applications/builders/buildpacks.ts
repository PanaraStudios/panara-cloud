import { quote } from "../../lib/shell";
import { appDirectory, type BuildInput, shellPairs } from "./utils";

const packBuild = (input: BuildInput, label: string, builder: string) => {
	const args = [
		"build",
		quote(input.appName),
		"--path",
		quote(appDirectory(input)),
		"--builder",
		quote(builder),
	];
	if (input.cleanCache) args.push("--clear-cache");
	for (const pair of shellPairs(input.env)) args.push("--env", pair);
	return `
echo "Starting ${label} build..." ;
pack ${args.join(" ")} || {
  echo "❌ ${label} build failed" ;
  exit 1;
}
echo "✅ ${label} build completed." ;
`;
};

// Heroku buildpacks build (`pack` with heroku/builder, 24 by default).
export const herokuBuild = (input: BuildInput) =>
	packBuild(input, "Heroku", `heroku/builder:${input.herokuVersion || "24"}`);

// Paketo buildpacks build (`pack` with the full Jammy builder).
export const paketoBuild = (input: BuildInput) =>
	packBuild(input, "Paketo", "paketobuildpacks/builder-jammy-full");
