import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	type APIRequestContext,
	type Browser,
	type BrowserContext,
	expect,
	type Page,
	request,
} from "@playwright/test";

export const LOG_FILE = path.resolve(
	import.meta.dirname,
	".state/convex-logs.jsonl",
);
export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
export const PASSWORD = "correct horse battery staple";

export function uniqueEmail(prefix: string) {
	return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.test`;
}

type AuthEmail = { kind: string; to: string; url: string };

function collectStrings(value: unknown, out: string[]) {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
	else if (value && typeof value === "object") {
		for (const v of Object.values(value)) collectStrings(v, out);
	}
}

function authEmails(): AuthEmail[] {
	const emails: AuthEmail[] = [];
	for (const line of readFileSync(LOG_FILE, "utf8").split("\n")) {
		if (!line.includes("auth.email")) continue;
		let event: { logLines?: unknown };
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		const texts: string[] = [];
		collectStrings(event.logLines, texts);
		for (const text of texts) {
			const start = text.indexOf("{");
			const end = text.lastIndexOf("}");
			if (start < 0 || end < start) continue;
			try {
				const message = JSON.parse(text.slice(start, end + 1));
				if (message.event === "auth.email") emails.push(message);
			} catch {}
		}
	}
	return emails;
}

export function emailCount(to: string, kind: string) {
	return authEmails().filter((e) => e.to === to && e.kind === kind).length;
}

// Returns the link of the (skip + 1)-th email of this kind sent to `to`.
export async function waitForEmail(to: string, kind: string, skip = 0) {
	let url = "";
	await expect
		.poll(
			() => {
				const matching = authEmails().filter(
					(e) => e.to === to && e.kind === kind,
				);
				url = matching[skip]?.url ?? "";
				return url;
			},
			{ timeout: 30_000, message: `waiting for ${kind} email to ${to}` },
		)
		.not.toBe("");
	return url;
}

export function totpAt(secret: string, step: number) {
	let bits = "";
	for (const c of secret.replace(/=+$/, "")) {
		bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
			.indexOf(c.toUpperCase())
			.toString(2)
			.padStart(5, "0");
	}
	const key = Buffer.from(
		(bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)),
	);
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(step));
	const hash = createHmac("sha1", key).update(counter).digest();
	const offset = (hash[19] ?? 0) & 15;
	return ((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000)
		.toString()
		.padStart(6, "0");
}

const usedSteps = new Map<string, number>();

// A TOTP code works once; wait for the next 30 s step if this one was used.
export async function freshTotp(secret: string) {
	let step = Math.floor(Date.now() / 30_000);
	while (step <= (usedSteps.get(secret) ?? -1)) {
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		step = Math.floor(Date.now() / 30_000);
	}
	usedSteps.set(secret, step);
	return totpAt(secret, step);
}

// The admin's session is kept in .state (gitignored) and reused by every
// worker and later runs while it lasts: the admin's sign-in is rate-limited
// (10 per 15 minutes) and each failed test restarts the worker.
const ADMIN_STATE = path.resolve(import.meta.dirname, ".state/admin.json");
let admin: Promise<APIRequestContext> | null = null;

function adminApi() {
	admin ??= (async () => {
		const email = process.env.E2E_ADMIN_EMAIL;
		const password = process.env.E2E_ADMIN_PASSWORD;
		if (!email || !password) {
			throw new Error("Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD");
		}
		const options = {
			baseURL: BASE_URL,
			extraHTTPHeaders: { origin: BASE_URL },
		};
		if (existsSync(ADMIN_STATE)) {
			const cached = await request.newContext({
				...options,
				storageState: ADMIN_STATE,
			});
			const session = await cached
				.get("/api/auth/get-session")
				.then((response) => response.json())
				.catch(() => null);
			if (session?.user?.email === email.toLowerCase()) return cached;
			await cached.dispose();
		}
		const api = await request.newContext(options);
		const response = await api.post("/api/auth/sign-in/email", {
			data: { email, password },
		});
		expect(response.ok(), await response.text()).toBeTruthy();
		await api.storageState({ path: ADMIN_STATE });
		return api;
	})();
	return admin;
}

// Test accounts join a dedicated organization, never the instance's real
// ones. A fresh one is started before Better Auth's membership limit (100)
// is near, since every run adds members.
const E2E_ORGANIZATION = "E2E Organization";
const MAX_E2E_MEMBERS = 70;
let e2eOrganization: Promise<{ id: string; name: string }> | null = null;

function organizationForTests() {
	e2eOrganization ??= (async () => {
		const api = await adminApi();
		const organizations: { id: string; name: string; createdAt: string }[] =
			await (await api.get("/api/auth/organization/list")).json();
		const candidates = organizations
			.filter((organization) => organization.name === E2E_ORGANIZATION)
			.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
		for (const organization of candidates) {
			const response = await api.get(
				`/api/auth/organization/list-members?organizationId=${organization.id}&limit=1`,
			);
			expect(response.ok(), await response.text()).toBeTruthy();
			const { total } = await response.json();
			if (total < MAX_E2E_MEMBERS) return organization;
		}
		const created = await api.post("/api/auth/organization/create", {
			data: { name: E2E_ORGANIZATION, slug: `e2e-${Date.now()}` },
		});
		expect(created.ok(), await created.text()).toBeTruthy();
		return created.json();
	})();
	return e2eOrganization;
}

let setupSkipped = false;

// A browser context signed in as the instance admin, reusing the API
// context's session so the admin's rate-limited sign-in runs once per worker.
// Its active organization is the test organization.
export async function adminContext(browser: Browser) {
	const api = await adminApi();
	const organization = await organizationForTests();
	const response = await api.post("/api/auth/organization/set-active", {
		data: { organizationId: organization.id },
	});
	expect(response.ok(), await response.text()).toBeTruthy();
	const context = await browser.newContext({
		storageState: await api.storageState(),
	});
	// A fresh instance sends its administrator from Projects to the one-time
	// panel setup; skip it once.
	if (!setupSkipped) {
		const page = await context.newPage();
		await page.goto("/");
		const skip = page.getByRole("button", { name: "Skip for now" });
		const shown = await skip.waitFor({ timeout: 8_000 }).then(
			() => true,
			() => false,
		);
		if (shown) await skip.click();
		await expect(
			page.getByRole("heading", { name: "Projects", level: 1 }),
		).toBeVisible();
		await page.close();
		setupSkipped = true;
	}
	return context;
}

export async function invite(email: string, role = "member") {
	const api = await adminApi();
	const organization = await organizationForTests();
	const response = await api.post("/api/auth/organization/invite-member", {
		data: { email, role, organizationId: organization.id },
	});
	expect(response.ok(), await response.text()).toBeTruthy();
	const invitation = await response.json();
	return {
		invitationId: invitation.id as string,
		organizationName: organization.name,
	};
}

// `verified`: signing up from an invitation link needs no verification
// email, so the form signs in instead of asking to check the inbox.
export async function fillSignUp(
	page: Page,
	{ name, email, password = PASSWORD }: Account,
	{
		verified = false,
		submit = "Create account",
	}: { verified?: boolean; submit?: string } = {},
) {
	await page.getByLabel("Name").fill(name);
	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password").fill(password);
	await page.getByRole("button", { name: submit, exact: true }).click();
	if (verified) return;
	await expect(
		page.getByRole("heading", { name: "Check your email" }),
	).toBeVisible();
}

export type Account = { name: string; email: string; password?: string };

// The signed-in home is the organization's projects list, or the one-time
// panel setup for the administrator of a fresh instance.
export const HOME_HEADING = /^(Projects|Set up your panel)$/;

export function expectHome(page: Page) {
	return expect(
		page.getByRole("heading", { name: HOME_HEADING, level: 1 }),
	).toBeVisible();
}

// What an account without an organization sees: its pending invitations.
export const NO_TEAM_HEADING = "You're not in a team yet";

// A new account belongs to no organization until it accepts its invitation;
// the dashboard lists it with Accept and Decline.
export async function joinInvitedOrganization(
	page: Page,
	organizationName: string,
) {
	const invitations = page.getByRole("list", { name: "Pending invitations" });
	await invitations
		.getByRole("listitem")
		.filter({ hasText: organizationName })
		.getByRole("button", { name: "Accept", exact: true })
		.click();
}

// A verification link signs the account in and lands on "Email verified",
// which continues on its own.
export async function openVerificationLink(page: Page, url: string) {
	await page.goto(url);
	await expect(
		page.getByRole("heading", { name: "Email verified" }),
	).toBeVisible();
}

export async function createAccount(
	page: Page,
	prefix: string,
	{ join = true }: { join?: boolean } = {},
) {
	const account = { name: `E2E ${prefix}`, email: uniqueEmail(prefix) };
	const { invitationId, organizationName } = await invite(account.email);
	await page.goto("/signup");
	await fillSignUp(page, account);
	await openVerificationLink(page, await waitForEmail(account.email, "verify"));
	await expect(
		page.getByRole("heading", { name: NO_TEAM_HEADING }),
	).toBeVisible();
	if (join) {
		await joinInvitedOrganization(page, organizationName);
		await expectHome(page);
	}
	return { ...account, password: PASSWORD, invitationId, organizationName };
}

export async function signIn(
	page: Page,
	email: string,
	password = PASSWORD,
	next = "/",
) {
	await page.goto(
		next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`,
	);
	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password", { exact: true }).fill(password);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

// The dashboard logs out from the account menu and confirms, like opensend;
// screens outside it (no organization yet) have a plain "Sign out" button.
export async function signOut(page: Page) {
	const accountMenu = page.getByRole("button", { name: "Account menu" });
	if (await accountMenu.isVisible()) {
		await accountMenu.click();
		await page.getByRole("menuitem", { name: "Log out" }).click();
		await page
			.getByRole("alertdialog")
			.getByRole("button", { name: "Log out" })
			.click();
	} else {
		await page.getByRole("button", { name: "Sign out" }).first().click();
	}
	await expect(page).toHaveURL(/\/login\?notice=signed-out/);
}

export async function addVirtualAuthenticator(
	context: BrowserContext,
	page: Page,
) {
	const cdp = await context.newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	await cdp.send("WebAuthn.addVirtualAuthenticator", {
		options: {
			protocol: "ctap2",
			transport: "internal",
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});
	return cdp;
}

export function alert(page: Page) {
	return page.locator('[role="alert"]');
}

const backendDir = path.resolve(
	import.meta.dirname,
	"../../../../packages/backend",
);

function betterAuthRun(fn: string, args: unknown) {
	const out = execFileSync(
		"npx",
		["convex", "run", "--component", "betterAuth", fn, JSON.stringify(args)],
		{ cwd: backendDir, encoding: "utf8" },
	);
	return out.trim() ? JSON.parse(out) : null;
}

// Backdates the user's sessions past session.freshAge (5 minutes), so
// sensitive actions require signing in again.
export function ageSessions(email: string) {
	const user = betterAuthRun("adapter:findOne", {
		model: "user",
		where: [{ field: "email", value: email }],
	});
	const sessions = betterAuthRun("adapter:findMany", {
		model: "session",
		where: [{ field: "userId", value: user._id }],
		paginationOpts: { numItems: 50, cursor: null },
	});
	for (const session of sessions.page) {
		betterAuthRun("adapter:updateOne", {
			input: {
				model: "session",
				update: { createdAt: Date.now() - 10 * 60_000 },
				where: [{ field: "_id", value: session._id }],
			},
		});
	}
}
