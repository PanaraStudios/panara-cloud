import type { HandlerMap } from "../index";
import { serverValidate } from "./serverValidate";

export const coreHandlers = {
	"server.validate": serverValidate,
	noop: async (ctx) => {
		if (ctx.claim.spec.kind === "noop") ctx.log.line(ctx.claim.spec.message);
		return { kind: "none" };
	},
} satisfies Partial<HandlerMap>;
