// A short-lived presigned S3 GET link for one file of a backup. Signing here
// needs no host round-trip. The destination secret is decrypted only inside the
// internal query that feeds this action and never leaves the backend.
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalQuery, type QueryCtx } from "../_generated/server";
import { requireInstanceAdmin } from "../infra/access";
import { requireServicePermission } from "../lib/permissions";
import { readSecret } from "../lib/secrets";
import { BACKUP_EXTENSIONS } from "./backups";
import {
	backupFolder,
	DESTINATION_SECRET_KIND,
	loadDestination,
	resolveOwner,
} from "./lib";
import { PANEL_BACKUP_EXTENSION, panelBackupFolder } from "./panelBackups";

const EXPIRES_SECONDS = 15 * 60;
const DEFAULT_REGION = "us-east-1";

const checkFileName = (fileName: string, extension: string) => {
	if (
		fileName.length > 512 ||
		fileName.startsWith(".") ||
		fileName.includes("/") ||
		!fileName.endsWith(extension)
	) {
		throw new ConvexError("Invalid backup file name");
	}
};

const destinationContext = async (
	ctx: QueryCtx,
	organizationId: string,
	destinationId: Id<"destinations">,
	key: string,
) => {
	const destination = await loadDestination(ctx, organizationId, destinationId);
	const secretAccessKey = await readSecret(
		ctx,
		DESTINATION_SECRET_KIND,
		destination._id,
	);
	if (secretAccessKey === null) {
		throw new ConvexError("Destination secret key is missing");
	}
	return {
		endpoint: destination.endpoint,
		region: destination.region,
		bucket: destination.bucket,
		accessKey: destination.accessKey,
		secretAccessKey,
		key,
	};
};

const downloadArgs = {
	backupId: v.optional(v.id("databaseBackups")),
	panelBackupId: v.optional(v.id("panelBackups")),
	fileName: v.string(),
};

export const downloadContext = internalQuery({
	args: downloadArgs,
	handler: async (ctx, { backupId, panelBackupId, fileName }) => {
		if (panelBackupId) {
			const { organizationId } = await requireInstanceAdmin(ctx);
			const backup = await ctx.db.get("panelBackups", panelBackupId);
			if (!backup || backup.organizationId !== organizationId) {
				throw new ConvexError("Panel backup not found");
			}
			checkFileName(fileName, PANEL_BACKUP_EXTENSION);
			return await destinationContext(
				ctx,
				organizationId,
				backup.destinationId,
				`${panelBackupFolder(backup.prefix)}${fileName}`,
			);
		}
		const backup = backupId
			? await ctx.db.get("databaseBackups", backupId)
			: null;
		if (!backup) throw new ConvexError("Backup not found");
		await requireServicePermission(
			ctx,
			{ _id: backup.owner.id, organizationId: backup.organizationId },
			"backup",
			"read",
		);
		checkFileName(fileName, BACKUP_EXTENSIONS[backup.databaseType]);
		const resolved = await resolveOwner(ctx, backup.owner);
		if (!resolved || resolved.organizationId !== backup.organizationId) {
			throw new ConvexError("Service not found");
		}
		return await destinationContext(
			ctx,
			backup.organizationId,
			backup.destinationId,
			`${backupFolder(resolved.appName, backup.serviceName, backup.prefix)}${fileName}`,
		);
	},
});

export const getDownloadUrl = action({
	args: downloadArgs,
	handler: async (ctx, args): Promise<{ url: string }> => {
		const context = await ctx.runQuery(
			internal.databases.downloads.downloadContext,
			args,
		);
		const region = context.region || DEFAULT_REGION;
		const base = new URL(
			context.endpoint
				? /^https?:\/\//.test(context.endpoint)
					? context.endpoint
					: `https://${context.endpoint}`
				: `https://s3.${region}.amazonaws.com`,
		);
		// Path-style, as rclone is configured for every destination.
		const path = `${base.pathname.replace(/\/+$/, "")}/${context.bucket}/${context.key}`;
		const url = await presignGetUrl({
			protocol: base.protocol,
			host: base.host,
			path,
			region,
			accessKey: context.accessKey,
			secretAccessKey: context.secretAccessKey,
			date: new Date(),
			expiresSeconds: EXPIRES_SECONDS,
		});
		return { url };
	},
});

const encoder = new TextEncoder();

const toHex = (bytes: ArrayBuffer) =>
	Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");

const hmac = async (key: BufferSource, data: string) => {
	const imported = await crypto.subtle.importKey(
		"raw",
		key,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return await crypto.subtle.sign("HMAC", imported, encoder.encode(data));
};

// RFC 3986 encoding, as SigV4 requires.
const uriEncode = (value: string, keepSlash: boolean) =>
	Array.from(encoder.encode(value), (byte) => {
		const char = String.fromCharCode(byte);
		if (/[A-Za-z0-9\-._~]/.test(char) || (keepSlash && char === "/")) {
			return char;
		}
		return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}).join("");

// AWS Signature V4 query-string signing for an unsigned-payload GET.
export const presignGetUrl = async (input: {
	protocol: string;
	host: string;
	path: string;
	region: string;
	accessKey: string;
	secretAccessKey: string;
	date: Date;
	expiresSeconds: number;
}) => {
	const amzDate = input.date.toISOString().replace(/[:-]|\.\d{3}/g, "");
	const day = amzDate.slice(0, 8);
	const scope = `${day}/${input.region}/s3/aws4_request`;
	const query: [string, string][] = [
		["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
		["X-Amz-Credential", `${input.accessKey}/${scope}`],
		["X-Amz-Date", amzDate],
		["X-Amz-Expires", String(input.expiresSeconds)],
		["X-Amz-SignedHeaders", "host"],
	];
	const canonicalQuery = query
		.map(
			([key, value]) => `${uriEncode(key, false)}=${uriEncode(value, false)}`,
		)
		.sort()
		.join("&");
	const canonicalPath = uriEncode(input.path, true);
	const canonicalRequest = [
		"GET",
		canonicalPath,
		canonicalQuery,
		`host:${input.host}\n`,
		"host",
		"UNSIGNED-PAYLOAD",
	].join("\n");
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		toHex(
			await crypto.subtle.digest("SHA-256", encoder.encode(canonicalRequest)),
		),
	].join("\n");
	let key: ArrayBuffer = await hmac(
		encoder.encode(`AWS4${input.secretAccessKey}`),
		day,
	);
	for (const part of [input.region, "s3", "aws4_request"]) {
		key = await hmac(key, part);
	}
	const signature = toHex(await hmac(key, stringToSign));
	return `${input.protocol}//${input.host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
};
