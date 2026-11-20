import { containerLookup } from "../databases/backup";
import type { ExecOptions, Host } from "../host";
import { quote } from "../lib/shell";

export type ScheduleRun =
	| {
			kind: "host";
			scheduleId: string;
			shellType: "bash" | "sh";
			script: string;
	  }
	| {
			kind: "application";
			shellType: "bash" | "sh";
			command: string;
			serviceAppName: string;
	  }
	| {
			kind: "compose";
			shellType: "bash" | "sh";
			command: string;
			serviceAppName: string;
			composeType: "docker-compose" | "stack";
			serviceName: string;
	  };

type ContainerRun = Exclude<ScheduleRun, { kind: "host" }>;

export const containerLookupFor = (run: ContainerRun): string =>
	containerLookup(
		run.kind === "application"
			? { kind: "swarm", appName: run.serviceAppName }
			: {
					kind: "compose",
					appName: run.serviceAppName,
					serviceName: run.serviceName,
					composeType: run.composeType,
				},
	);

export const findRunningContainer = async (
	host: Host,
	lookup: string,
	signal?: AbortSignal,
): Promise<string | null> => {
	const result = await host.exec(lookup, { signal });
	return result.output.trim().split("\n")[0]?.trim() || null;
};

export const containerExecCommand = (
	containerId: string,
	shellType: "bash" | "sh",
	command: string,
) =>
	`docker exec ${quote(containerId)} ${quote(shellType)} -c ${quote(command)}`;

// The script arrives on stdin and is written to a private temp file owned by
// the SSH user, so non-root users can run it and nothing is left behind.
export const hostScriptCommand = (shellType: "bash" | "sh") =>
	[
		"set -e",
		'f=$(mktemp "${TMPDIR:-/tmp}/panara-cloud-schedule-XXXXXX")',
		"trap 'rm -f \"$f\"' EXIT",
		'cat > "$f"',
		'chmod 700 "$f"',
		"set +e",
		`${shellType} "$f" </dev/null`,
	].join("\n");

export const hostScript = (scheduleId: string, script: string) =>
	`echo "PID: $$ | Schedule ID: "${quote(scheduleId)}\n${script}\n`;

export const runSchedule = async (
	host: Host,
	run: ScheduleRun,
	options: Pick<ExecOptions, "onOutput" | "signal">,
): Promise<number | null> => {
	if (run.kind === "host") {
		const result = await host.exec(hostScriptCommand(run.shellType), {
			...options,
			input: hostScript(run.scheduleId, run.script),
		});
		return result.code;
	}
	const containerId = await findRunningContainer(
		host,
		containerLookupFor(run),
		options.signal,
	);
	if (!containerId) {
		const target =
			run.kind === "compose"
				? `service '${run.serviceName}' of compose '${run.serviceAppName}'`
				: `application '${run.serviceAppName}'`;
		throw new Error(
			`Container not found for ${target}, make sure the service is running`,
		);
	}
	options.onOutput?.(
		`docker exec ${containerId.slice(0, 12)} ${run.shellType} -c ${run.command}\n`,
	);
	const result = await host.exec(
		containerExecCommand(containerId, run.shellType, run.command),
		options,
	);
	return result.code;
};
