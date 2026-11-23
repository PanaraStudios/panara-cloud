// Changes a database password: the new password is applied inside the running
// container first and only then replaces the stored one.
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalMutation } from "../_generated/server";
import { encryptSecret } from "../lib/crypto";
import { enqueueJob } from "../lib/jobs";
import { putSecret } from "../lib/secrets";
import { recordServiceEvent } from "../lib/serviceEvents";
import {
	ENGINES,
	groupFor,
	loadDatabase,
	PENDING_PASSWORD_KIND,
	partitionOf,
	validatePassword,
} from "./lib";

const passwordUser = v.union(v.literal("user"), v.literal("root"));

export const changePassword = action({
	args: {
		databaseId: v.id("databases"),
		password: v.string(),
		user: v.optional(passwordUser),
	},
	handler: async (ctx, { databaseId, password, user }): Promise<Id<"jobs">> => {
		validatePassword(password);
		return await ctx.runMutation(internal.databases.passwords.request, {
			databaseId,
			user: user ?? "user",
			...(await encryptSecret(password)),
		});
	},
});

export const request = internalMutation({
	args: {
		databaseId: v.id("databases"),
		user: passwordUser,
		iv: v.string(),
		ciphertext: v.string(),
	},
	handler: async (ctx, { databaseId, user, iv, ciphertext }) => {
		const { database, userId } = await loadDatabase(
			ctx,
			databaseId,
			"service",
			"create",
		);
		if (user === "root" && !ENGINES[database.engine].hasRootPassword) {
			throw new ConvexError(`${database.engine} has no separate root password`);
		}
		await recordServiceEvent(
			ctx,
			"database",
			database,
			"config.password",
			userId,
			{ fields: [user] },
		);
		const jobId = await enqueueJob(ctx, {
			organizationId: database.organizationId,
			partition: partitionOf(database.serverId),
			group: groupFor(database.engine, database._id),
			spec: { kind: "databases.changePassword", databaseId, user },
			idempotent: false,
			requestedBy: userId,
		});
		await putSecret(ctx, {
			organizationId: database.organizationId,
			kind: PENDING_PASSWORD_KIND,
			ownerId: jobId,
			iv,
			ciphertext,
		});
		return jobId;
	},
});
