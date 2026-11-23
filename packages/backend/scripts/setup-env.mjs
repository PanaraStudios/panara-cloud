// Generates the deployment secrets this backend needs and stores them as
// Convex env vars via stdin, so values never appear in process arguments or
// logs. Existing values are kept unless --rotate-agent-key is passed.
import { ensureGeneratedSecrets } from "./convex-cli.mjs";

ensureGeneratedSecrets({
	rotateAgentKey: process.argv.includes("--rotate-agent-key"),
});
