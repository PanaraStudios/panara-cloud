// No Convex imports: the web app reads this as `@panara-cloud/backend/serverState`.

/** Whether a server can take work, without saying anything else about it. */
export type ServerWorkState = "ready" | "inactive" | "offline" | "notSetUp";

// What SSH and Node report when the host can't be reached at all, as opposed
// to a host that answers but is missing software.
const CONNECTION_FAILURE =
	/ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ECONNRESET|timed? ?out|handshake|unreachable|connection refused|could not connect|cannot connect|All configured authentication methods failed|host key/i;

export const isConnectionFailure = (message: string | null | undefined) =>
	!!message && CONNECTION_FAILURE.test(message);

/** `lastValidation` only changes when someone checks the server, so a failed
    connection stays "offline" until the next check. */
export const serverWorkState = (server: {
	serverStatus?: "active" | "inactive";
	sshKeyId?: string;
	lastValidation?: { ok: boolean; details: string };
}): ServerWorkState => {
	if (!server.sshKeyId) return "notSetUp";
	if (server.serverStatus === "inactive") return "inactive";
	if (
		server.lastValidation &&
		!server.lastValidation.ok &&
		isConnectionFailure(server.lastValidation.details)
	) {
		return "offline";
	}
	return "ready";
};
