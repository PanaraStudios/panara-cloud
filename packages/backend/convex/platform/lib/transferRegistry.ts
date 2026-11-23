import type { FunctionReference } from "convex/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

export type TransferSection = {
	// Stable bundle key, e.g. "applications". Never rename once shipped.
	key: string;
	// internalQuery: rows to export for these environments of the project.
	// Strip organization-specific references (servers, git providers,
	// registries) unless `includeLinks` (same-organization copies). Secrets go in a row's `secrets` record (plaintext, keyed
	// by field name) only when `includeSecrets` is set, which happens only
	// for passphrase-encrypted bundles.
	exportRows: FunctionReference<
		"query",
		"internal",
		{
			projectId: Id<"projects">;
			environmentIds: Id<"environments">[];
			includeSecrets: boolean;
			includeLinks?: boolean;
		},
		unknown[]
	>;
	// internalMutation: recreates rows inside the import transaction.
	// `environmentIdMap` maps exported environment ids to the new ones;
	// `serverId` is the target server for rows without links. Each
	// row's `secrets` arrives replaced by `sealedSecrets` (encrypted by the
	// import action); importers must ignore unknown secret fields.
	importRows: FunctionReference<
		"mutation",
		"internal",
		{
			organizationId: string;
			projectId: Id<"projects">;
			environmentIdMap: Record<string, Id<"environments">>;
			rows: unknown[];
			serverId?: Id<"servers">;
		},
		{ warnings: string[] }
	>;
	// Secret fields every row must have; the import action generates random
	// values for the ones a bundle lacks (e.g. database passwords in an
	// unencrypted export).
	requiredSecrets?: string[];
};

// Extension point for project export/import: each domain that owns
// project-scoped entities appends one entry here (e.g.
// `{ key: "applications", exportRows: internal.applications.transfer.exportRows,
// importRows: internal.applications.transfer.importRows }`).
export const transferSections: TransferSection[] = [
	{
		key: "applications",
		exportRows: internal.applications.projectExport.exportRows,
		importRows: internal.applications.projectExport.importRows,
	},
	{
		key: "compose",
		exportRows: internal.compose.projectExport.exportRows,
		importRows: internal.compose.projectExport.importRows,
	},
	{
		key: "databases",
		exportRows: internal.databases.projectExport.exportRows,
		importRows: internal.databases.projectExport.importRows,
		requiredSecrets: ["password", "rootPassword"],
	},
];
