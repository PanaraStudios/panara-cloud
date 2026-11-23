// Which public functions the API gateway (`/api/v1/call/<name>`, and the MCP
// server built on it) serves.
//
// Every public function is served unless it is denied here. The panel's UI
// already reaches each of them from the browser and each one authorizes its
// caller itself, so an API key, which acts as its user inside one
// organization, gets the same surface. What is denied is what a stored,
// non-interactive credential must not do. A function reaches the gateway only
// through the generated list in apiFunctions.ts, and apiCatalog.test.ts fails
// until a new public function is added to that list (served) or to this file
// (denied), so the choice is made when the function is written.

export type FunctionKind = "query" | "mutation" | "action";

const AGENT = "Called by the Panara Cloud agent with its own credentials";
const API_KEYS = "API keys are managed by a signed-in user in the panel";
const ACCOUNT =
	"Changes the signed-in user's own account, which needs a browser session";
const SESSION = "Reads the signed-in user's own account and sessions";
const BROWSER_FLOW =
	"Starts a flow that continues in the browser and returns to the panel";
const UI = "Internal to the panel's own pages";
// Kept in step with PEOPLE_AND_ACCESS_BY_KEY in lib/access.ts, which the
// functions themselves enforce.
const PEOPLE = "People and access are managed by a signed-in user in the panel";

// Convex module path -> reason. Covers every public function of the module.
export const DENIED_MODULES: Record<string, string> = {
	agent: AGENT,
	"applications/agent": AGENT,
	"compose/agent": AGENT,
	"databases/agent": AGENT,
	"infra/agent": AGENT,
	"live/agent": AGENT,
	"platform/agent": AGENT,
	"sources/agent": AGENT,
	"platform/apiKeys": API_KEYS,
	"platform/onboarding": UI,
};

// API name (`module.function`) -> reason.
export const DENIED_FUNCTIONS: Record<string, string> = {
	"applications.rollbackImages.getContext": AGENT,
	"infra.mounts.getMountFileContext": AGENT,
	"live.monitoringHistory.record": AGENT,
	"platform.vaultActions.resolveForJob": AGENT,
	"serviceEvents.reportRuntime": AGENT,
	"serviceEvents.watchTargets": AGENT,

	"account.changeEmailWithoutConfirmation": ACCOUNT,
	"account.generateAvatarUploadUrl": ACCOUNT,
	"account.updateAvatar": ACCOUNT,
	"account.revokeSession": ACCOUNT,
	"account.revokeOtherSessions": ACCOUNT,
	"account.setDefaultOrganization": ACCOUNT,
	"account.security": SESSION,
	"account.sessions": SESSION,
	"account.organizations":
		"Lists every organization of the user; an API key acts for one",
	"auth.getCurrentUser": SESSION,
	"live.sessions.mine":
		"Lists the user's live sessions in every organization; an API key acts for one",

	"sources.github.beginManifest": BROWSER_FLOW,
	"sources.github.beginInstall": BROWSER_FLOW,
	"sources.gitlab.beginAuthorize": BROWSER_FLOW,
	"sources.gitea.beginAuthorize": BROWSER_FLOW,
	"live.sessions.open":
		"Opens a terminal or live log stream for the browser on the agent's WebSocket endpoint",

	"users.createWithCredentials": PEOPLE,
	"users.invite": PEOPLE,
	"users.passwordResetLink": PEOPLE,
	"users.setDeactivated": PEOPLE,
	"users.removeAccount": PEOPLE,
	"account.removeInvitation": PEOPLE,
	"permissions.assign": PEOPLE,

	"account.registrationOpen": UI,
	"email.status": UI,
};

// `applications/deploy:start` <-> `applications.deploy.start`. Module and
// function names never contain a dot, so the mapping is exact both ways.
export const apiName = (convexPath: string): string =>
	convexPath.replaceAll("/", ".").replace(":", ".");

export const convexPath = (name: string): string => {
	const split = name.lastIndexOf(".");
	return `${name.slice(0, split).replaceAll(".", "/")}:${name.slice(split + 1)}`;
};

export const moduleOf = (name: string): string =>
	name.slice(0, name.lastIndexOf("."));

// The first path segment: the filter unit of the MCP endpoint's `groups`.
export const groupOf = (name: string): string =>
	name.slice(0, name.indexOf("."));

export const denyReason = (name: string): string | null =>
	DENIED_FUNCTIONS[name] ??
	DENIED_MODULES[moduleOf(name).replaceAll(".", "/")] ??
	null;
