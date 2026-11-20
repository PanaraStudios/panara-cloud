import { quote } from "../lib/shell";
import type { LiveConnection } from "./connection";
import { AccessDenied, assertSwarmAccess, labelFilters } from "./ownership";
import type { RequestOf, Restriction } from "./protocol";
import {
	errorMessage,
	type SessionContext,
	type SessionHandler,
} from "./session";

export const CONTAINERS_POLL_MS = 5000;
const MAX_ROWS = 500;

type ListRequest = RequestOf<"serviceContainers">;

export type ServiceContainerRow = {
	containerId: string;
	name: string;
	state: string;
	status: string;
};

export type ServiceTaskRow = {
	containerId: string;
	name: string;
	state: string;
	node: string;
	currentState: string;
	error: string;
};

const filters = (values: string[]) =>
	values.map((value) => `--filter ${quote(value)}`).join(" ");

// An app's containers: the compose project or stack labels,
// otherwise the swarm service label, plus the caller's ownership labels.
export const nativeListCommand = (
	request: Pick<ListRequest, "appName" | "appType">,
	restriction: Restriction,
) => {
	const label =
		request.appType === "stack"
			? `label=com.docker.stack.namespace=${request.appName}`
			: request.appType === "docker-compose"
				? `label=com.docker.compose.project=${request.appName}`
				: `label=com.docker.swarm.service.name=${request.appName}`;
	return `docker ps -a ${filters([label, ...labelFilters(restriction)])} --format '{{json .}}'`;
};

// Tasks of a swarm service or stack (`docker service ps` / `docker stack ps`).
export const swarmListCommand = (
	request: Pick<ListRequest, "appName" | "appType">,
) =>
	`docker ${request.appType === "stack" ? "stack" : "service"} ps ${quote(request.appName)} --no-trunc --format '{{json .}}'`;

const jsonLines = (output: string): Record<string, unknown>[] =>
	output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("{"))
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as Record<string, unknown>];
			} catch {
				return [];
			}
		})
		.slice(0, MAX_ROWS);

const text = (value: unknown) => (value === undefined ? "" : String(value));

export const parseContainerRows = (output: string): ServiceContainerRow[] =>
	jsonLines(output).map((row) => ({
		containerId: text(row.ID),
		name: text(row.Names),
		state: text(row.State),
		status: text(row.Status),
	}));

export const parseTaskRows = (output: string): ServiceTaskRow[] =>
	jsonLines(output).map((row) => ({
		containerId: text(row.ID),
		name: text(row.Name),
		state: text(row.DesiredState),
		node: text(row.Node),
		currentState: text(row.CurrentState),
		error: text(row.Error),
	}));

// A stack's tasks may be listed when the caller may reach one of its services.
const assertStackAccess = async (
	conn: LiveConnection,
	stack: string,
	restriction: Restriction,
) => {
	const out = await conn.runOk(
		`docker service ls -q ${filters([`label=com.docker.stack.namespace=${stack}`, ...labelFilters(restriction)])}`,
	);
	if (!out.trim()) throw new AccessDenied("Not authorized for this stack");
};

export const listServiceContainers = async (
	conn: LiveConnection,
	request: ListRequest,
	restriction: Restriction,
): Promise<ServiceContainerRow[] | ServiceTaskRow[]> => {
	if (request.mode === "native") {
		return parseContainerRows(
			await conn.runOk(nativeListCommand(request, restriction)),
		);
	}
	// Checked on every poll: a name that resolves to nothing now may name
	// someone else's service later. Tasks are then listed by the checked
	// service ID, so the name can't be re-pointed in between.
	let target = request.appName;
	if (request.appType === "stack") {
		await assertStackAccess(conn, request.appName, restriction);
	} else {
		const exists = await conn.run(
			`docker service inspect --format '{{.ID}}' ${quote(request.appName)}`,
		);
		// A service that was never deployed (or was removed) has no tasks.
		if (exists.code !== 0) return [];
		target = await assertSwarmAccess(conn, request.appName, restriction);
	}
	const result = await conn.run(
		swarmListCommand({ appName: target, appType: request.appType }),
	);
	if (result.code !== 0) return [];
	return parseTaskRows(result.stdout);
};

// Lists the service's containers (or swarm tasks) and re-sends the list
// whenever it changes, so selectors follow restarts without a page reload.
export const startServiceContainers = async (
	ctx: SessionContext,
): Promise<SessionHandler> => {
	const request = ctx.redeemed.request as ListRequest;
	const { restriction } = ctx.redeemed;
	let stopped = false;
	let last = "";
	const send = (rows: unknown[]) => {
		const json = JSON.stringify(rows);
		if (json === last) return;
		last = json;
		ctx.send({ type: "list", data: rows });
	};
	// Listed before the session is ready so a refusal fails it; sent after
	// the ready frame.
	const initial = await listServiceContainers(ctx.conn, request, restriction);
	setImmediate(() => {
		if (!stopped) send(initial);
	});
	const loop = async () => {
		while (!stopped) {
			await new Promise((resolve) => setTimeout(resolve, CONTAINERS_POLL_MS));
			if (stopped) return;
			try {
				send(await listServiceContainers(ctx.conn, request, restriction));
			} catch (error) {
				if (!stopped) ctx.send({ type: "error", message: errorMessage(error) });
			}
		}
	};
	void loop();
	return {
		dispose: () => {
			stopped = true;
		},
	};
};
