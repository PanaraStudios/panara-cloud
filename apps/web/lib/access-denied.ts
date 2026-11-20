export type DeniedResource = "service" | "project" | "environment";

const DENIED = /You don't have access to this (service|project|environment)\b/;

// The backend's permission refusal (lib/permissions.ts) carried by a failed
// Convex query: a ConvexError's `data`, or the message of an error rethrown
// by the client.
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
	return match ? (match[1] as DeniedResource) : null;
}
