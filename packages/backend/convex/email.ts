import { ConvexError, type Infer, v } from "convex/values";
import { components, internal } from "./_generated/api";
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import { encryptSecret } from "./lib/crypto";
import { deleteSecret, putSecret, readSecret } from "./lib/secrets";
import { assertAllowedEndpoint, providerFetch } from "./platform/lib/fetch";
import { emailProviderKind } from "./tables/email";

// Account email (verification, invitations, password resets) goes through,
// in order: the provider connected in Settings → Email, the env-configured
// Resend component (RESEND_API_KEY + AUTH_EMAIL_FROM), or, in development,
// the Convex logs (LOG_AUTH_LINKS=true). With none of them the instance runs
// without email: the first account and invited accounts need no
// verification, and the UI shows links instead of mailing them.

export const PROVIDERS = {
	opensend: { label: "opensend.cc", baseUrl: "https://api.opensend.cc" },
	resend: { label: "Resend", baseUrl: "https://api.resend.com" },
} as const;

export type EmailProviderKind = Infer<typeof emailProviderKind>;

const SECRET_KIND = "email.apiKey";
// Instance-level secrets don't belong to an organization.
const SECRET_ORGANIZATION = "instance";
const MAX_ATTEMPTS = 5;

export type DeliveryMode = "provider" | "env" | "log" | "none";

export const instanceProvider = (ctx: QueryCtx) =>
	ctx.db
		.query("emailProvider")
		.withIndex("by_key", (q) => q.eq("key", "instance"))
		.unique();

export const envResendConfigured = () =>
	Boolean(process.env.RESEND_API_KEY && process.env.AUTH_EMAIL_FROM);

export const logAuthLinks = () => process.env.LOG_AUTH_LINKS === "true";

export const deliveryMode = async (ctx: QueryCtx): Promise<DeliveryMode> => {
	if (await instanceProvider(ctx)) return "provider";
	if (envResendConfigured()) return "env";
	if (logAuthLinks()) return "log";
	return "none";
};

const requireInstanceAdmin = async (ctx: QueryCtx) => {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) throw new ConvexError("Not signed in");
	const isAdmin = await ctx.runQuery(
		components.betterAuth.policy.isInstanceAdmin,
		{ userId: identity.subject },
	);
	if (!isAdmin) {
		throw new ConvexError(
			"Only the instance administrator can change email settings",
		);
	}
	return identity.subject;
};

// Public: the auth pages use it to show links and next steps instead of
// promising emails that won't arrive.
export const status = query({
	args: {},
	returns: v.object({ enabled: v.boolean() }),
	handler: async (ctx) => ({ enabled: (await deliveryMode(ctx)) !== "none" }),
});

export const settings = query({
	args: {},
	handler: async (ctx) => {
		const userId = await requireInstanceAdmin(ctx);
		const [config, account] = await Promise.all([
			instanceProvider(ctx),
			ctx.runQuery(components.betterAuth.users.accountState, { userId }),
		]);
		return {
			adminEmail: account?.email ?? null,
			mode: await deliveryMode(ctx),
			provider: config
				? {
						provider: config.provider,
						from: config.from,
						baseUrl: config.baseUrl ?? null,
						defaultBaseUrl: PROVIDERS[config.provider].baseUrl,
						apiKeyHint: config.apiKeyHint,
						updatedAt: config.updatedAt,
						lastSentAt: config.lastSentAt ?? null,
						lastError: config.lastError ?? null,
						lastErrorAt: config.lastErrorAt ?? null,
					}
				: null,
		};
	},
});

const FROM =
	/^(?:[^<>]*<\s*[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+\s*>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/;

const normalizeBaseUrl = (value: string | undefined) => {
	const trimmed = value?.trim().replace(/\/+$/, "");
	if (!trimmed) return undefined;
	try {
		assertAllowedEndpoint(trimmed);
	} catch (error) {
		throw new ConvexError(
			error instanceof Error ? error.message : "Invalid base URL",
		);
	}
	return trimmed;
};

// The key is encrypted here (actions only: IVs need real randomness) and is
// never returned to the client; only its last four characters are kept in
// the clear so the page can tell keys apart.
export const saveProvider = action({
	args: {
		provider: emailProviderKind,
		from: v.string(),
		apiKey: v.optional(v.string()),
		baseUrl: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<null> => {
		const from = args.from.trim();
		if (!FROM.test(from) || from.length > 320) {
			throw new ConvexError(
				'Use an address like "Panara Cloud <no-reply@example.com>"',
			);
		}
		const apiKey = args.apiKey?.trim();
		if (apiKey !== undefined && (apiKey.length < 8 || apiKey.length > 512)) {
			throw new ConvexError("That API key doesn't look right");
		}
		await ctx.runMutation(internal.email.storeProvider, {
			provider: args.provider,
			from,
			baseUrl: normalizeBaseUrl(args.baseUrl),
			key: apiKey
				? { ...(await encryptSecret(apiKey)), hint: apiKey.slice(-4) }
				: undefined,
		});
		return null;
	},
});

export const storeProvider = internalMutation({
	args: {
		provider: emailProviderKind,
		from: v.string(),
		baseUrl: v.optional(v.string()),
		key: v.optional(
			v.object({ iv: v.string(), ciphertext: v.string(), hint: v.string() }),
		),
	},
	handler: async (ctx, args) => {
		const userId = await requireInstanceAdmin(ctx);
		const existing = await instanceProvider(ctx);
		if (!existing && !args.key) throw new ConvexError("Enter the API key");
		const fields = {
			provider: args.provider,
			from: args.from,
			baseUrl: args.baseUrl,
			updatedAt: Date.now(),
			updatedBy: userId,
			lastError: undefined,
			lastErrorAt: undefined,
		};
		let configId = existing?._id;
		if (existing) {
			await ctx.db.patch("emailProvider", existing._id, {
				...fields,
				...(args.key ? { apiKeyHint: args.key.hint } : {}),
			});
		} else if (args.key) {
			configId = await ctx.db.insert("emailProvider", {
				key: "instance",
				...fields,
				apiKeyHint: args.key.hint,
			});
		}
		if (args.key && configId) {
			await putSecret(ctx, {
				organizationId: SECRET_ORGANIZATION,
				kind: SECRET_KIND,
				ownerId: configId,
				iv: args.key.iv,
				ciphertext: args.key.ciphertext,
			});
		}
	},
});

export const disconnect = mutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		await requireInstanceAdmin(ctx);
		const existing = await instanceProvider(ctx);
		if (!existing) return null;
		await deleteSecret(ctx, SECRET_KIND, existing._id);
		await ctx.db.delete("emailProvider", existing._id);
		return null;
	},
});

const providerTarget = v.object({
	provider: emailProviderKind,
	from: v.string(),
	baseUrl: v.string(),
	apiKey: v.string(),
});

export const loadProvider = internalQuery({
	args: {},
	returns: v.union(v.null(), providerTarget),
	handler: async (ctx) => {
		const config = await instanceProvider(ctx);
		if (!config) return null;
		const apiKey = await readSecret(ctx, SECRET_KIND, config._id);
		if (!apiKey) return null;
		return {
			provider: config.provider,
			from: config.from,
			baseUrl: config.baseUrl ?? PROVIDERS[config.provider].baseUrl,
			apiKey,
		};
	},
});

const mail = v.object({
	to: v.string(),
	subject: v.string(),
	html: v.string(),
	text: v.string(),
});

type SendResult =
	| { ok: true; id: string | null }
	| {
			ok: false;
			retryable: boolean;
			retryAfterMs: number | null;
			error: string;
	  };

// Resend's `POST /emails`, which opensend.cc implements unchanged.
export const sendWithProvider = async (
	target: Infer<typeof providerTarget>,
	message: Infer<typeof mail>,
	idempotencyKey: string,
): Promise<SendResult> => {
	let response: Response;
	try {
		response = await providerFetch(`${target.baseUrl}/emails`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${target.apiKey}`,
				"Idempotency-Key": idempotencyKey,
			},
			body: JSON.stringify({
				from: target.from,
				to: [message.to],
				subject: message.subject,
				html: message.html,
				text: message.text,
			}),
		});
	} catch (error) {
		return {
			ok: false,
			retryable: true,
			retryAfterMs: null,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	const body = (await response.json().catch(() => null)) as {
		id?: unknown;
		message?: unknown;
	} | null;
	if (response.ok) {
		return { ok: true, id: typeof body?.id === "string" ? body.id : null };
	}
	const retryAfter = Number(response.headers.get("retry-after"));
	const reason =
		typeof body?.message === "string" ? body.message : response.statusText;
	return {
		ok: false,
		retryable: response.status === 429 || response.status >= 500,
		retryAfterMs:
			Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
		error: `${PROVIDERS[target.provider].label} answered ${response.status}: ${reason}`,
	};
};

// Scheduled by authEmail.send. Retries rate limits, server errors and network
// failures with backoff; the Idempotency-Key stops a retry from sending twice.
export const deliver = internalAction({
	args: {
		mail,
		idempotencyKey: v.string(),
		attempt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const target = await ctx.runQuery(internal.email.loadProvider, {});
		if (!target) {
			console.warn(
				JSON.stringify({ event: "email.dropped", reason: "no provider" }),
			);
			return;
		}
		const attempt = args.attempt ?? 1;
		const result = await sendWithProvider(
			target,
			args.mail,
			args.idempotencyKey,
		);
		if (result.ok) {
			await ctx.runMutation(internal.email.recordResult, { error: null });
			return;
		}
		if (result.retryable && attempt < MAX_ATTEMPTS) {
			const backoff = result.retryAfterMs ?? 2 ** attempt * 1000;
			await ctx.scheduler.runAfter(
				Math.min(backoff, 5 * 60 * 1000),
				internal.email.deliver,
				{ ...args, attempt: attempt + 1 },
			);
			return;
		}
		console.error(
			JSON.stringify({ event: "email.failed", attempt, error: result.error }),
		);
		await ctx.runMutation(internal.email.recordResult, { error: result.error });
	},
});

export const recordResult = internalMutation({
	args: { error: v.union(v.string(), v.null()) },
	handler: async (ctx, { error }) => {
		const config = await instanceProvider(ctx);
		if (!config) return;
		const now = Date.now();
		await ctx.db.patch(
			"emailProvider",
			config._id,
			error === null
				? { lastSentAt: now, lastError: undefined, lastErrorAt: undefined }
				: { lastError: error.slice(0, 500), lastErrorAt: now },
		);
	},
});

export const testRecipient = internalQuery({
	args: {},
	handler: async (ctx) => {
		const userId = await requireInstanceAdmin(ctx);
		const account = await ctx.runQuery(
			components.betterAuth.users.accountState,
			{ userId },
		);
		if (!account) throw new ConvexError("Account not found");
		return account.email;
	},
});

// Sends synchronously so the page can show the provider's answer.
export const sendTest = action({
	args: {},
	returns: v.object({ ok: v.boolean(), error: v.union(v.string(), v.null()) }),
	handler: async (ctx) => {
		const to: string = await ctx.runQuery(internal.email.testRecipient, {});
		const target = await ctx.runQuery(internal.email.loadProvider, {});
		if (!target) throw new ConvexError("Connect a provider first");
		const result = await sendWithProvider(
			target,
			{
				to,
				subject: "Panara Cloud test email",
				text: `Email delivery works. Panara Cloud will send account email through ${PROVIDERS[target.provider].label} from ${target.from}.\n`,
				html: `<p>Email delivery works. Panara Cloud will send account email through ${PROVIDERS[target.provider].label}.</p>`,
			},
			crypto.randomUUID(),
		);
		await ctx.runMutation(internal.email.recordResult, {
			error: result.ok ? null : result.error,
		});
		return { ok: result.ok, error: result.ok ? null : result.error };
	},
});
