import { api } from "@panara-cloud/backend/api";
import { connectHost } from "../../host";
import {
	banIp,
	configureFail2ban,
	disconnectSession,
	panelKeyFingerprint,
	removeAuthorizedKey,
	setFail2banEnabled,
	unbanIp,
	updateSshSettings,
} from "../../infra/security";
import { type JobContext, JobFailure, type JobResult } from "../types";
import {
	leaseArgs,
	refreshSnapshot,
	type SnapshotKind,
	specOf,
	withJobHost,
} from "./common";
import { readSnapshot } from "./host";

export const serverSecurity = async (ctx: JobContext): Promise<JobResult> => {
	const { action } = specOf(ctx, "infra.serverSecurity");
	const context = await ctx.convex.query(
		api.infra.agent.getSecurityContext,
		leaseArgs(ctx),
	);
	const target = await ctx.getTarget();
	if (target.type !== "ssh") {
		throw new JobFailure("Server security applies to remote servers only");
	}
	const panelFingerprint = panelKeyFingerprint({
		privateKey: target.privateKey,
		publicKey: context.panelPublicKey,
	});
	ctx.log.line(`Running ${action.type}`);
	let refresh: SnapshotKind[] = [];
	await withJobHost(ctx, async (host) => {
		switch (action.type) {
			case "configureFail2ban":
				await configureFail2ban(host, action.config, context.panelIps, (t) =>
					ctx.log.append(t),
				);
				refresh = ["fail2ban"];
				break;
			case "setFail2banEnabled":
				await setFail2banEnabled(host, action.enabled);
				refresh = ["fail2ban"];
				break;
			case "banIp":
				await banIp(host, action.ip, context.panelIps);
				refresh = ["fail2ban"];
				break;
			case "unbanIp":
				await unbanIp(host, action.jail, action.ip);
				refresh = ["fail2ban"];
				break;
			case "updateSsh":
				await updateSshSettings(
					host,
					{
						passwordAuthentication: action.passwordAuthentication,
						permitRootLogin: action.permitRootLogin,
						maxAuthTries: action.maxAuthTries,
					},
					target.username,
					() => connectHost(target, ctx.signal),
				);
				refresh = ["sshSecurity"];
				break;
			case "removeAuthorizedKey":
				await removeAuthorizedKey(host, action.fingerprint, panelFingerprint);
				refresh = ["sshSecurity"];
				break;
			case "disconnectSession":
				await disconnectSession(
					host,
					action.terminal,
					action.banIp,
					context.panelIps,
				);
				refresh = action.banIp ? ["activity", "fail2ban"] : ["activity"];
				break;
		}
		for (const kind of refresh) {
			await refreshSnapshot(ctx, kind, () => readSnapshot(ctx, host, kind));
		}
	});
	ctx.log.line("Done ✅");
	return { kind: "none" };
};
