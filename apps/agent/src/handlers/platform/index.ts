import type { HandlerMap } from "../index";
import { scheduleRun } from "./scheduleRun";
import { vectorReconcile } from "./vectorReconcile";

export const platformHandlers = {
	"platform.scheduleRun": scheduleRun,
	"platform.vectorReconcile": vectorReconcile,
} satisfies Partial<HandlerMap>;
