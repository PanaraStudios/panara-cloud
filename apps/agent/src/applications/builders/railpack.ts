import { createHash } from "node:crypto";
import { quote } from "../../lib/shell";
import {
	appDirectory,
	type BuildInput,
	exportSecrets,
	shellPairs,
} from "./utils";

const secretsHash = (env: string[]) => {
	const hash = createHash("sha256");
	for (const pair of [...env].sort()) hash.update(pair);
	return hash.digest("hex");
};

// Railpack build: `railpack prepare` writes a build plan that
// the railpack BuildKit frontend builds in a per-build buildx builder.
export const railpackBuild = (input: BuildInput): string => {
	const directory = appDirectory(input);
	const plan = `${directory}/railpack-plan.json`;
	const info = `${directory}/railpack-info.json`;
	const prepareArgs = [
		"prepare",
		quote(directory),
		"--plan-out",
		quote(plan),
		"--info-out",
		quote(info),
	];
	for (const pair of shellPairs(input.env)) prepareArgs.push("--env", pair);

	const builder = `railpack-${input.appName}-${input.nonce}`.slice(0, 63);
	const env = Object.fromEntries(
		input.env.map((pair) => {
			const index = pair.indexOf("=");
			return [pair.slice(0, index), pair.slice(index + 1)];
		}),
	);
	const secrets = exportSecrets(env);
	const buildArgs = [
		"buildx",
		"build",
		"--builder",
		quote(builder),
		"--build-arg",
		quote(`secrets-hash=${secretsHash(input.env)}`),
		...(input.cleanCache
			? ["--build-arg", quote(`cache-key=${input.nonce}`)]
			: []),
		"--build-arg",
		quote(
			`BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v${input.railpackVersion}`,
		),
		"-f",
		quote(plan),
		"--output",
		quote(`type=docker,name=${input.appName}`),
		...secrets.keys.flatMap((key) => [
			"--secret",
			quote(`id=${key},env=${key}`),
		]),
		quote(directory),
	];

	return `
export RAILPACK_VERSION=${quote(input.railpackVersion)}
if ! railpack --version 2>/dev/null | grep -q "$RAILPACK_VERSION"; then
  echo "Installing railpack $RAILPACK_VERSION..." ;
  if [ "$(id -u)" -eq 0 ]; then SUDO_CMD=""; elif sudo -n true 2>/dev/null; then SUDO_CMD="sudo"; else SUDO_CMD=""; fi
  $SUDO_CMD bash -c "$(curl -fsSL https://railpack.com/install.sh)" || {
    echo "❌ Railpack install failed" ;
    exit 1;
  }
fi
docker buildx create --name ${quote(builder)} --driver docker-container >/dev/null || true
railpack_builder=${quote(builder)}
trap 'docker buildx rm "$railpack_builder" >/dev/null 2>&1 || true' EXIT

echo "Preparing Railpack build plan..." ;
railpack ${prepareArgs.join(" ")} || {
  echo "❌ Railpack prepare failed" ;
  exit 1;
}
echo "✅ Railpack prepare completed." ;

echo "Building with Railpack frontend..." ;
${secrets.docker(buildArgs.join(" "))} || {
  echo "❌ Railpack build failed" ;
  exit 1;
}
echo "✅ Railpack build completed." ;
`;
};
