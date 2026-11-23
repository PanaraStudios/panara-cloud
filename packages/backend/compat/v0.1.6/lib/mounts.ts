// The one validator v0.1.6's tables take from convex/lib/mounts.ts, as it
// was at that tag.
import { v } from "convex/values";

export const mountOwner = v.object({ kind: v.string(), id: v.string() });
