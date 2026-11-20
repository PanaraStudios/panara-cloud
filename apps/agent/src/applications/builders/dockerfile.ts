import { posix } from "node:path";
import { quote } from "../../lib/shell";
import { within } from "../paths";
import {
	type BuildInput,
	dockerfilePath,
	envFileCommand,
	exportSecrets,
	shellPairs,
} from "./utils";

// Dockerfile build: `docker build` with the configured Dockerfile, context,
// target stage, build args and secrets.
export const dockerfileBuild = (input: BuildInput): string => {
	const file = dockerfilePath(input);
	const context = input.dockerContextPath
		? within(input.codeDir, input.dockerContextPath)
		: posix.dirname(file);
	const args = [
		"build",
		"-t",
		quote(input.appName),
		"-f",
		quote(file),
		quote(context),
	];
	if (input.dockerBuildStage)
		args.push("--target", quote(input.dockerBuildStage));
	if (input.cleanCache) args.push("--no-cache");
	for (const arg of shellPairs(input.buildArgs)) args.push("--build-arg", arg);
	const secrets = exportSecrets(input.buildSecrets);
	for (const key of secrets.keys) {
		// type=env so buildx never falls back to reading a file named like the key.
		args.push("--secret", quote(`type=env,id=${key}`));
	}

	let script = "";
	// The env file could be served publicly from a publish directory.
	if (!input.publishDirectory && input.createEnvFile) {
		script += envFileCommand(input.codeDir, file, input.env);
	}
	script += `
echo ${quote(`Building ${input.appName}`)} ;
cd ${quote(context)} || {
  echo ${quote(`❌ The path ${context} does not exist`)} ;
  exit 1;
}
${secrets.docker(args.join(" "))} || {
  echo "❌ Docker build failed" ;
  exit 1;
}
echo "✅ Docker build completed." ;
`;
	return script;
};
