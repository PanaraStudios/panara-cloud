import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { enqueueJob } from "../lib/jobs";
import { putSecret } from "../lib/secrets";
import { DESTINATION_DRAFT_KIND, partitionOf } from "./lib";

const assertServer = async (
	ctx: MutationCtx,
	organizationId: string,
	serverId: Id<"servers"> | undefined,
) => {
	if (!serverId) return;
	const server = await ctx.db.get("servers", serverId);
	if (!server || server.organizationId !== organizationId) {
		throw new ConvexError("Server not found");
	}
};

// Creates the op row and its job; the UI follows `opResult(opId)`.
export const startOp = async (
	ctx: MutationCtx,
	input: {
		organizationId: string;
		serverId?: Id<"servers">;
		request: Doc<"databaseOps">["request"];
		requestedBy: string;
		draftSecret?: { iv: string; ciphertext: string };
	},
): Promise<{ opId: Id<"databaseOps">; jobId: Id<"jobs"> }> => {
	await assertServer(ctx, input.organizationId, input.serverId);
	const opId = await ctx.db.insert("databaseOps", {
		organizationId: input.organizationId,
		request: input.request,
		done: false,
	});
	if (input.draftSecret) {
		await putSecret(ctx, {
			organizationId: input.organizationId,
			kind: DESTINATION_DRAFT_KIND,
			ownerId: opId,
			...input.draftSecret,
		});
	}
	const jobId = await enqueueJob(ctx, {
		organizationId: input.organizationId,
		partition: partitionOf(input.serverId),
		group: `databaseOp:${opId}`,
		spec:
			input.request.kind === "testDestination"
				? { kind: "databases.testDestination", opId }
				: { kind: "databases.listBackupFiles", opId },
		idempotent: true,
		requestedBy: input.requestedBy,
	});
	await ctx.db.patch("databaseOps", opId, { jobId });
	return { opId, jobId };
};
