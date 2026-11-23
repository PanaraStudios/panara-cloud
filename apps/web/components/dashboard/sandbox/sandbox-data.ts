import type { api } from "@panara-cloud/backend/api";
import type { FunctionReturnType } from "convex/server";

type SandboxDoc = NonNullable<
	FunctionReturnType<typeof api.live.sandboxes.get>
>;

// The sandbox row shape the screens read (ids and dates) from a Convex
// sandbox document.
export const toSandbox = (doc: SandboxDoc) => ({
	...doc,
	sandboxId: doc._id as string,
	createdAt: new Date(doc._creationTime).toISOString(),
	expiresAt: doc.expiresAt === undefined ? null : new Date(doc.expiresAt),
	deadlineAt: new Date(doc.deadlineAt),
	template: doc.template ?? null,
	runtime: doc.runtime ?? null,
	containerId: doc.containerId ?? null,
});

export type Sandbox = ReturnType<typeof toSandbox>;
