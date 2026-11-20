import { posix } from "node:path";
import { quote } from "../../lib/shell";
import { within } from "../paths";
import { staticBuild } from "./static";
import { appDirectory, type BuildInput, shellPairs } from "./utils";

// Nixpacks build. With a publish directory the built files are
// copied out of the nixpacks image and served by the static builder.
export const nixpacksBuild = (input: BuildInput): string => {
	const directory = appDirectory(input);
	const args = ["build", quote(directory), "--name", quote(input.appName)];
	if (input.cleanCache) args.push("--no-cache");
	for (const pair of shellPairs(input.env)) args.push("--env", pair);
	// nginx serves the published files, so no start command is needed.
	if (input.publishDirectory) args.push("--no-error-without-start");

	let script = `
echo "Starting nixpacks build..." ;
nixpacks ${args.join(" ")} || {
  echo "❌ Nixpacks build failed" ;
  exit 1;
}
echo "✅ Nixpacks build completed." ;
`;
	if (input.publishDirectory) {
		const container = `${input.appName}-${input.nonce}`;
		const localPath = within(directory, input.publishDirectory);
		const isDirectory =
			input.publishDirectory.endsWith("/") ||
			!posix.extname(input.publishDirectory);
		const from = `${container}:/app/${input.publishDirectory}${isDirectory ? "/." : ""}`;
		script += `
docker create --name ${quote(container)} ${quote(input.appName)}
mkdir -p ${quote(localPath)}
docker cp ${quote(from)} ${quote(localPath)} || {
  docker rm ${quote(container)}
  echo ${quote(`❌ Copying ${input.publishDirectory} to ${localPath} failed`)} ;
  exit 1;
}
docker rm ${quote(container)}
${staticBuild(input)}
`;
	}
	return script;
};
