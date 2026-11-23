import { herokuBuild, paketoBuild } from "./buildpacks";
import { dockerfileBuild } from "./dockerfile";
import { nixpacksBuild } from "./nixpacks";
import { railpackBuild } from "./railpack";
import { staticBuild } from "./static";
import { assertSafeInput, type BuildInput } from "./utils";

export type { BuildInput, BuildType } from "./utils";

// The bash script that builds `input.appName` (tagged :latest) from the code
// in `input.codeDir`. Run it with `runScript` (../process.ts).
export const buildScript = (input: BuildInput): string => {
	assertSafeInput(input);
	const body = (() => {
		switch (input.buildType) {
			case "dockerfile":
				return dockerfileBuild(input);
			case "nixpacks":
				return nixpacksBuild(input);
			case "railpack":
				return railpackBuild(input);
			case "heroku_buildpacks":
				return herokuBuild(input);
			case "paketo_buildpacks":
				return paketoBuild(input);
			case "static":
				return staticBuild(input);
		}
	})();
	return `set -e\n${body}`;
};
