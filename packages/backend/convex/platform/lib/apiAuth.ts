import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { trustedClientIp } from "../../authLimits";
import type { Role } from "../../lib/access";
import { sha256Hex } from "../../lib/crypto";
import { MAX_API_KEY_LENGTH } from "../apiKeys";

export type ApiPrincipal = {
	apiKeyId: Id<"apiKeys">;
	userId: string;
	organizationId: string;
	role: Role;
};

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly headers: Record<string, string> = {},
	) {
		super(message);
	}
}

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

const readKey = (req: Request): string | null => {
	const header = req.headers.get("x-api-key");
	if (header) return header.trim();
	const authorization = req.headers.get("authorization");
	const match = authorization ? /^Bearer\s+(.+)$/i.exec(authorization) : null;
	return match ? match[1].trim() : null;
};

// Authenticates a REST request by `x-api-key` or `Authorization: Bearer`.
// Throws ApiError (401/403/429) for the response; see `jsonError`.
export const requireApiKey = async (
	ctx: Pick<ActionCtx, "runMutation">,
	req: Request,
	minRole: Role = "member",
): Promise<ApiPrincipal> => {
	const key = readKey(req);
	// Keys may carry a custom prefix, so only the shape is checked here.
	if (!key || key.length < 16 || key.length > MAX_API_KEY_LENGTH) {
		throw new ApiError(401, "Missing or malformed API key");
	}
	const result = await ctx.runMutation(internal.platform.apiKeys.authenticate, {
		hash: await sha256Hex(key),
		clientIp: trustedClientIp(req.headers) ?? undefined,
	});
	if (!result.ok) {
		throw new ApiError(
			result.status,
			result.error,
			result.retryAfter ? { "Retry-After": String(result.retryAfter) } : {},
		);
	}
	if (RANK[result.role] < RANK[minRole]) {
		throw new ApiError(403, `Requires the ${minRole} role`);
	}
	return {
		apiKeyId: result.apiKeyId,
		userId: result.userId,
		organizationId: result.organizationId,
		role: result.role,
	};
};

export const jsonError = (error: unknown): Response => {
	if (error instanceof ApiError) {
		return Response.json(
			{ error: error.message },
			{ status: error.status, headers: error.headers },
		);
	}
	console.error("API request failed", error);
	return Response.json({ error: "Internal error" }, { status: 500 });
};

// `/api/v1/me`: who the key acts as.
export const whoAmI = async (
	ctx: Pick<ActionCtx, "runMutation">,
	req: Request,
): Promise<Response> => {
	try {
		const principal = await requireApiKey(ctx, req);
		return Response.json({
			userId: principal.userId,
			organizationId: principal.organizationId,
			role: principal.role,
		});
	} catch (error) {
		return jsonError(error);
	}
};
