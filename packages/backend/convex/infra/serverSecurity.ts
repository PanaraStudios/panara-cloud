import { ConvexError, type Infer, v } from "convex/values";
import { mutation } from "../_generated/server";
import { securityAction } from "../tables/infra";
import { requireHostAccess } from "./access";
import { enqueueHostJob } from "./hostJobs";
import { isIp, isIpOrCidr } from "./validation";

type SecurityAction = Infer<typeof securityAction>;

const validate = (action: SecurityAction, sshUser: string) => {
	switch (action.type) {
		case "configureFail2ban": {
			const { bantime, findtime, maxretry, ignoreip } = action.config;
			for (const [label, value, min] of [
				["Ban time", bantime, -1],
				["Find time", findtime, 1],
				["Max retries", maxretry, 1],
			] as const) {
				if (!Number.isInteger(value) || value < min || value > 31_536_000) {
					throw new ConvexError(`${label} is out of range`);
				}
			}
			if (ignoreip.length > 100 || !ignoreip.every(isIpOrCidr)) {
				throw new ConvexError("Ignored addresses must be IPs or CIDR ranges");
			}
			return;
		}
		case "banIp":
			if (!isIp(action.ip)) throw new ConvexError("Invalid IP address");
			return;
		case "unbanIp":
			if (!/^[\w.-]+$/.test(action.jail) || !isIp(action.ip)) {
				throw new ConvexError("Invalid jail or IP address");
			}
			return;
		case "updateSsh":
			if (
				!Number.isInteger(action.maxAuthTries) ||
				action.maxAuthTries < 1 ||
				action.maxAuthTries > 100
			) {
				throw new ConvexError("Max auth tries must be between 1 and 100");
			}
			if (sshUser === "root" && action.permitRootLogin === "no") {
				throw new ConvexError(
					"Panara Cloud connects to this server as root. Use 'prohibit-password' instead of disabling root login, or connect with a sudo user first",
				);
			}
			return;
		case "removeAuthorizedKey":
			if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(action.fingerprint)) {
				throw new ConvexError("Invalid key fingerprint");
			}
			return;
		case "disconnectSession":
			if (!/^(pts\/\d+|tty\d+)$/.test(action.terminal)) {
				throw new ConvexError("Invalid terminal");
			}
			if (action.banIp !== undefined && !isIp(action.banIp)) {
				throw new ConvexError("Invalid IP address");
			}
			return;
		case "setFail2banEnabled":
			return;
	}
};

// Fail2ban, IP bans, SSH hardening, authorized keys and sessions on a remote
// server. Reads use snapshots (fail2ban, exposedPorts, pendingUpdates,
// sshSecurity, activity); each change refreshes the affected snapshot.
export const run = mutation({
	args: { serverId: v.id("servers"), action: securityAction },
	handler: async (ctx, { serverId, action }) => {
		const scope = await requireHostAccess(ctx, serverId, "admin");
		validate(action, scope.server?.username ?? "");
		return await enqueueHostJob(ctx, scope, `security:${serverId}`, {
			kind: "infra.serverSecurity",
			serverId,
			action,
		});
	},
});
