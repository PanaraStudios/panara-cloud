import type { MutationCtx } from "../_generated/server";

const BATCH = 200;

// Ends live sessions (terminals, logs, Docker streams) whose authorization
// no longer holds: a membership removed, changed or deactivated, or an
// organization deleted. Pending ones close now; open ones are flagged for
// the agent, which watches killRequested and closes the stream.
export const revokeLiveSessions = async (
	ctx: MutationCtx,
	scope:
		| { userId: string; organizationId?: string }
		| { organizationId: string },
) => {
	for (const status of ["pending", "open"] as const) {
		const sessions =
			"userId" in scope
				? (
						await ctx.db
							.query("liveSessions")
							.withIndex("by_userId_and_status", (q) =>
								q.eq("userId", scope.userId).eq("status", status),
							)
							.take(BATCH)
					).filter(
						(s) =>
							scope.organizationId === undefined ||
							s.organizationId === scope.organizationId,
					)
				: await ctx.db
						.query("liveSessions")
						.withIndex("by_organizationId_and_status", (q) =>
							q.eq("organizationId", scope.organizationId).eq("status", status),
						)
						.take(BATCH);
		for (const session of sessions) {
			if (status === "pending") {
				await ctx.db.patch("liveSessions", session._id, {
					status: "closed",
					closedAt: Date.now(),
					closeReason: "access revoked",
				});
			} else if (!session.killRequested) {
				await ctx.db.patch("liveSessions", session._id, {
					killRequested: true,
				});
			}
		}
	}
};
