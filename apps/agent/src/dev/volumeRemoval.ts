// Runs "delete a compose project with its volumes" against real Docker on
// this machine, without the panel, to see what the agent would decide:
//   tsx src/dev/volumeRemoval.ts <project> [--together=<project>,...]
//       [--panel=<volume>=<appName>=<label>]... [--no-swarm]
// It tears the project down (`docker compose -p <project> down`) and removes
// those of its own volumes nothing else uses, exactly as the removal job
// does. `--panel` stands in for the panel's answer (a service defined there
// that names the volume), `--together` for services deleted in the same
// action, `--no-swarm` skips reading the Swarm services. The Traefik network
// and the /etc/panara-cloud directories of a real removal are not touched.
import { projectVolumes } from "../compose/host";
import { LocalHost } from "../host/local";
import {
	inspectContainerVolumeUse,
	inspectVolumeUse,
	removeUnusedVolumes,
} from "../infra/volumeRemoval";

const main = async () => {
	const args = process.argv.slice(2);
	const appName = args.find((arg) => !arg.startsWith("--"));
	if (!appName) {
		console.error("usage: tsx src/dev/volumeRemoval.ts <project> [options]");
		process.exit(1);
	}
	const option = (name: string) =>
		args.flatMap((arg) =>
			arg.startsWith(`--${name}=`) ? [arg.slice(name.length + 3)] : [],
		);
	const panel = option("panel").map((value) => value.split("="));
	const host = new LocalHost();
	const candidates = await projectVolumes(host, {
		appName,
		composeType: "docker-compose",
	});
	console.log(
		`candidates: ${candidates.map((candidate) => (candidate.anonymous ? `${candidate.name.slice(0, 12)} (anonymous)` : candidate.name)).join(", ") || "(none)"}`,
	);
	await host.run(
		`env -i PATH="$PATH" HOME="$HOME" docker compose -p ${appName} down --remove-orphans 2>&1`,
	);
	const outcome = await removeUnusedVolumes(host, {
		candidates,
		deleting: [appName],
		deletingTogether: option("together").flatMap((value) => value.split(",")),
		inspect: args.includes("--no-swarm")
			? inspectContainerVolumeUse
			: inspectVolumeUse,
		panelReferences: async (names) => ({
			incomplete: null,
			volumes: panel.flatMap(([volumeName, owner, label]) =>
				volumeName && names.includes(volumeName)
					? [
							{
								volumeName,
								services: [{ appName: owner ?? "", label: label ?? "" }],
							},
						]
					: [],
			),
		}),
		log: (text) => process.stdout.write(`job log: ${text}`),
	});
	console.log(`outcome: ${JSON.stringify(outcome)}`);
};

await main();
