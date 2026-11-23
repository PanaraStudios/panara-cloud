import { v } from "convex/values";
import type { TableNames } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";

// The first document id in a gateway call's arguments that is not an id of
// the table its validator names, or null (see lib/apiArgs.ts).
export const firstInvalidId = internalQuery({
	args: {
		ids: v.array(v.object({ tableName: v.string(), id: v.string() })),
	},
	handler: async (ctx, { ids }): Promise<number | null> => {
		for (const [index, { tableName, id }] of ids.entries()) {
			let valid: boolean;
			try {
				valid = ctx.db.normalizeId(tableName as TableNames, id) !== null;
			} catch {
				// Not a table of this deployment (a component's): Convex decides.
				valid = true;
			}
			if (!valid) return index;
		}
		return null;
	},
});
