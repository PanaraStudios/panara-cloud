import { withHost } from "../../host";
import { type JobContext, JobFailure, type JobResult } from "../types";

const CHECKS: { label: string; command: string; required: boolean }[] = [
	{ label: "System", command: "uname -srm", required: true },
	{
		label: "OS",
		command: '. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"',
		required: false,
	},
	{
		label: "Docker",
		command: "docker version --format '{{.Server.Version}}'",
		required: true,
	},
	{
		label: "Docker Compose",
		command: "docker compose version --short",
		required: true,
	},
	{
		label: "Swarm",
		command: "docker info --format '{{.Swarm.LocalNodeState}}'",
		required: false,
	},
	{
		label: "Disk free",
		command: "df -h / | awk 'NR==2 {print $4}'",
		required: false,
	},
];

export const serverValidate = async (ctx: JobContext): Promise<JobResult> => {
	const target = await ctx.getTarget();
	if (target.type !== "ssh") {
		throw new JobFailure("server.validate requires an SSH target");
	}
	ctx.log.line(
		`Connecting to ${target.username}@${target.host}:${target.port}`,
	);
	const summary: string[] = [];
	let ok = true;
	await withHost(target, ctx.signal, async (host) => {
		for (const check of CHECKS) {
			if (ctx.signal.aborted) throw new JobFailure("Cancelled");
			ctx.log.line(`$ ${check.command}`);
			const result = await host.exec(check.command, {
				onOutput: (t) => ctx.log.append(t),
				signal: ctx.signal,
			});
			const value = result.output.trim().split("\n").at(-1) ?? "";
			const passed = result.code === 0 && value.length > 0;
			summary.push(`${check.label}: ${passed ? value : "unavailable"}`);
			if (!passed && check.required) ok = false;
		}
	});
	const details = summary.join("\n");
	ctx.log.line(
		ok ? "Server is ready." : "Server is missing required software.",
	);
	const result: JobResult = { kind: "server.validate", ok, details };
	if (!ok) throw new JobFailure("Validation failed", result);
	return result;
};
