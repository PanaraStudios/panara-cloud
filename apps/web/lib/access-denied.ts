export type DeniedResource =
	| "service"
	| "project"
	| "environment"
	| "server"
	| "page";

const DENIED =
	/You don't have access to this (service|project|environment|server)\b/;

// Refusals that name a permission or a role instead of the thing refused.
const NOT_ALLOWED =
	/Requires the [\w.]+ permission|Requires the (?:owner|admin|member) role|Requires an instance administrator|Not a member of this organization|Only the instance administrator can/;

// The backend's permission refusal (lib/permissions.ts, lib/access.ts)
// carried by a failed Convex query: a ConvexError's `data`, or the message of
// an error rethrown by the client. "page" when it doesn't say what was refused.
export function deniedResource(error: unknown): DeniedResource | null {
	if (!error || typeof error !== "object") return null;
	const { data, message } = error as { data?: unknown; message?: unknown };
	const text =
		typeof data === "string"
			? data
			: typeof message === "string"
				? message
				: "";
	const match = DENIED.exec(text);
	if (match) return match[1] as DeniedResource;
	return NOT_ALLOWED.test(text) ? "page" : null;
}
