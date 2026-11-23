import { jsonToConvex } from "convex/values";
import { importPKCS8, SignJWT } from "jose";
import catalogJson from "../../../api/catalog.json";
import { internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";
import {
	API_KEY_NOT_ALLOWED,
	API_KEY_WRONG_ORGANIZATION,
	apiKeyIssuer,
	PEOPLE_AND_ACCESS_BY_KEY,
} from "../../lib/access";
import { checkArgs } from "./apiArgs";
import {
	ApiError,
	type ApiPrincipal,
	jsonError,
	requireApiKey,
} from "./apiAuth";
import { API_FUNCTIONS } from "./apiFunctions";
import { convexPath, denyReason, type FunctionKind } from "./apiPolicy";
import type { Catalog, ValidatorJson } from "./apiSpec";

const ARGS = new Map<string, ValidatorJson>(
	(catalogJson as Catalog).functions.map((fn) => [fn.name, fn.args]),
);

// The function gateway: `POST /api/v1/call/<module>.<function>` runs a public
// Convex function as the API key's user. After the key is checked, a JWT for
// that user, bound to the key's organization, is signed with the agent key
// pair and the function is called through the deployment's own function API,
// so every permission check runs exactly as it does for the panel's UI. The
// token is made and used inside this action; no client ever holds one.

export const API_KEY_AUDIENCE = "panara-cloud-api";
export const CALL_PREFIX = "/api/v1/call/";

// Longer than the longest action (10 minutes), so the token cannot expire
// while its call runs.
const TOKEN_TTL_SECONDS = 11 * 60;
const UDF_FAILED = 560;
// The port the Convex backend listens on inside its container.
const LOOPBACK_URL = "http://127.0.0.1:3210";

const mintToken = async (principal: ApiPrincipal): Promise<string> => {
	const privateKey = process.env.AGENT_JWT_PRIVATE_KEY;
	const keyId = process.env.AGENT_JWT_KID;
	if (!privateKey || !keyId) {
		throw new ApiError(503, "The API is not configured on this panel");
	}
	return await new SignJWT({
		organizationId: principal.organizationId,
		apiKeyId: principal.apiKeyId,
	})
		.setProtectedHeader({ alg: "ES256", kid: keyId })
		.setIssuer(apiKeyIssuer())
		.setAudience(API_KEY_AUDIENCE)
		.setSubject(principal.userId)
		.setIssuedAt()
		.setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
		.sign(await importPKCS8(privateKey, "ES256"));
};

const isLoopback = (url: string): boolean => {
	try {
		const { hostname } = new URL(url);
		return (
			hostname === "localhost" ||
			hostname === "127.0.0.1" ||
			hostname === "[::1]"
		);
	} catch {
		return false;
	}
};

// Where this deployment answers function calls, most direct first.
// CONVEX_CLOUD_URL is the public origin on an installed panel, which the
// backend's own container may not be able to reach (no hairpin route), so it
// is only the fallback there.
export const functionApiUrls = (): string[] => {
	const configured = process.env.PANARA_CLOUD_FUNCTION_API_URL;
	if (configured) return [configured];
	const own = process.env.CONVEX_CLOUD_URL;
	if (!own) return [LOOPBACK_URL];
	return isLoopback(own) ? [own] : [LOOPBACK_URL, own];
};

const reachable = async (base: string): Promise<boolean> => {
	try {
		return (await fetch(`${base}/version`)).ok;
	} catch {
		return false;
	}
};

const trimSlash = (url: string) => url.replace(/\/+$/, "");

const postFunction = async (
	kind: FunctionKind,
	body: string,
	token: string,
): Promise<Response> => {
	const urls = functionApiUrls().map(trimSlash);
	for (const [index, base] of urls.entries()) {
		try {
			return await fetch(`${base}/api/${kind}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body,
			});
		} catch (error) {
			const last = index === urls.length - 1;
			// Only move on when this address never answers: a call that broke
			// midway may already have run.
			if (last || (await reachable(base))) {
				console.error("API gateway could not reach the function API", error);
				throw new ApiError(502, "The API could not reach the backend");
			}
		}
	}
	throw new ApiError(502, "The API could not reach the backend");
};

const FORBIDDEN_MESSAGES = new Set([
	API_KEY_WRONG_ORGANIZATION,
	API_KEY_NOT_ALLOWED,
	PEOPLE_AND_ACCESS_BY_KEY,
	"This account has been deactivated",
]);
const FORBIDDEN_PATTERNS = [
	/^Requires /,
	/^Not a member of /,
	/^You don't have access /,
	/^Only (the|an) /,
	/administrator/i,
];

// ConvexError messages are written for users, so they pass through; the
// status is read off the message.
export const rejectionStatus = (message: string): number => {
	if (message === "Not authenticated" || message === "Not signed in") {
		return 401;
	}
	if (
		FORBIDDEN_MESSAGES.has(message) ||
		FORBIDDEN_PATTERNS.some((pattern) => pattern.test(message))
	) {
		return 403;
	}
	if (/\bnot found\b/i.test(message)) return 404;
	return 400;
};

// "ArgumentValidationError: Value does not match validator.\nPath: .name\n
// Value: 5.0\nValidator: v.string()". The first line and the path say what
// to fix; the rest repeats the caller's own input.
const argumentError = (message: string): string | null => {
	const match = /ArgumentValidationError: ([^\n]+)/.exec(message);
	if (!match) return null;
	const reason = match[1].replace(/\s*Consider wrapping .*$/, "").trim();
	const path = /\nPath: (\.[^\n]+)/.exec(message);
	return path ? `${reason} Path: ${path[1].trim()}` : reason;
};

type FunctionResult =
	| { status: "success"; value: unknown }
	| { status: "error"; errorMessage?: string; errorData?: unknown };

const toResponse = async (
	name: string,
	upstream: Response,
): Promise<Response> => {
	if (!upstream.ok && upstream.status !== UDF_FAILED) {
		console.error(
			`API gateway: function API answered ${upstream.status} for ${name}`,
		);
		throw new ApiError(
			upstream.status === 400 ? 400 : 500,
			upstream.status === 400 ? "Invalid arguments" : "Internal error",
		);
	}
	const result = (await upstream.json()) as FunctionResult;
	if (result.status === "success") {
		return Response.json({ data: result.value ?? null });
	}
	if (result.errorData !== undefined) {
		const data = result.errorData;
		const message = typeof data === "string" ? data : "Request rejected";
		return Response.json(
			typeof data === "string" ? { error: message } : { error: message, data },
			{ status: rejectionStatus(message) },
		);
	}
	const message = result.errorMessage ?? "";
	const invalid = argumentError(message);
	if (invalid) throw new ApiError(400, `Invalid arguments: ${invalid}`);
	if (/Could not find public function/.test(message)) {
		throw new ApiError(404, `Unknown function ${name}`);
	}
	// Anything else is an unexpected failure whose message may hold internals;
	// the function's own log has the details.
	console.error(`API gateway: ${name} failed`);
	throw new ApiError(500, "Internal error");
};

// Well above any function's arguments (the largest are files such as a
// compose file or a Traefik configuration, capped at 512 KB).
export const MAX_ARGS_BYTES = 4 * 1024 * 1024;
const TOO_LARGE = "Arguments are larger than 4 MB";

const readArgs = async (
	req: Request,
): Promise<{
	json: Record<string, unknown>;
	value: Record<string, unknown>;
}> => {
	if (Number(req.headers.get("content-length") ?? 0) > MAX_ARGS_BYTES) {
		throw new ApiError(413, TOO_LARGE);
	}
	const text =
		req.method === "GET"
			? (new URL(req.url).searchParams.get("args") ?? "")
			: await req.text();
	if (text.length > MAX_ARGS_BYTES) throw new ApiError(413, TOO_LARGE);
	let parsed: unknown;
	try {
		parsed = text.trim() === "" ? {} : JSON.parse(text);
	} catch {
		throw new ApiError(400, "Arguments must be a JSON object");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ApiError(400, "Arguments must be a JSON object");
	}
	let value: Record<string, unknown>;
	try {
		value = jsonToConvex(
			parsed as Parameters<typeof jsonToConvex>[0],
		) as Record<string, unknown>;
	} catch {
		throw new ApiError(400, "Arguments are not valid Convex JSON");
	}
	return { json: parsed as Record<string, unknown>, value };
};

const checkCallArgs = async (
	ctx: Pick<ActionCtx, "runQuery">,
	name: string,
	args: Record<string, unknown>,
) => {
	const validator = ARGS.get(name);
	if (!validator) return;
	const { error, ids } = checkArgs(validator, args);
	if (error) throw new ApiError(400, `Invalid arguments: ${error}`);
	if (ids.length === 0) return;
	const invalid = await ctx.runQuery(
		internal.platform.apiGatewayChecks.firstInvalidId,
		{ ids: ids.map(({ tableName, id }) => ({ tableName, id })) },
	);
	if (invalid !== null) {
		const { tableName, path } = ids[invalid];
		throw new ApiError(
			400,
			`Invalid arguments: Value does not match validator. Path: ${path} (an id of ${tableName})`,
		);
	}
};

export const handleApiCall = async (
	ctx: Pick<ActionCtx, "runMutation" | "runQuery">,
	req: Request,
): Promise<Response> => {
	try {
		const principal = await requireApiKey(ctx, req);
		let name: string;
		try {
			name = decodeURIComponent(
				new URL(req.url).pathname.slice(CALL_PREFIX.length),
			);
		} catch {
			throw new ApiError(404, "Unknown function");
		}
		const kind = Object.hasOwn(API_FUNCTIONS, name)
			? API_FUNCTIONS[name]
			: undefined;
		if (!kind) throw new ApiError(404, `Unknown function ${name}`);
		const denied = denyReason(name);
		if (denied) {
			throw new ApiError(
				403,
				`${name} is not available with an API key: ${denied}`,
			);
		}
		if (req.method === "GET" && kind !== "query") {
			throw new ApiError(
				405,
				`${name} is ${kind === "action" ? "an action" : "a mutation"}: call it with POST`,
				{ Allow: "POST" },
			);
		}
		const args = await readArgs(req);
		await checkCallArgs(ctx, name, args.value);
		const upstream = await postFunction(
			kind,
			JSON.stringify({
				path: convexPath(name),
				format: "convex_encoded_json",
				args: [args.json],
			}),
			await mintToken(principal),
		);
		return await toResponse(name, upstream);
	} catch (error) {
		return jsonError(error);
	}
};
