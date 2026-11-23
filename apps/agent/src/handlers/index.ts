import { applicationsHandlers } from "./applications";
import { composeHandlers } from "./compose";
import { coreHandlers } from "./core";
import { databasesHandlers } from "./databases";
import { infraHandlers } from "./infra";
import { liveHandlers } from "./live";
import { platformHandlers } from "./platform";
import { sourcesHandlers } from "./sources";
import type { Claim, JobContext, JobResult } from "./types";

export type JobKind = Claim["spec"]["kind"];
export type Handler = (ctx: JobContext) => Promise<JobResult>;
export type HandlerMap = Record<JobKind, Handler>;

// Every job kind in the backend schema must have a handler; a missing one is
// a type error here.
const handlers: HandlerMap = {
	...coreHandlers,
	...infraHandlers,
	...sourcesHandlers,
	...platformHandlers,
	...applicationsHandlers,
	...composeHandlers,
	...databasesHandlers,
	...liveHandlers,
};

export const capabilities = Object.keys(handlers);

export const handlerFor = (kind: JobKind): Handler => handlers[kind];
