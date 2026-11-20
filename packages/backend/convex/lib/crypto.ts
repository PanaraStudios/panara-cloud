import { ConvexError } from "convex/values";

const toBase64 = (bytes: Uint8Array): string => {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array<ArrayBuffer> =>
	Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

const importKey = async (): Promise<CryptoKey> => {
	const raw = process.env.SECRETS_KEY;
	if (!raw) {
		throw new ConvexError("SECRETS_KEY is not configured");
	}
	const bytes = fromBase64(raw);
	if (bytes.length !== 32) {
		throw new ConvexError("SECRETS_KEY must be 32 bytes, base64-encoded");
	}
	return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
};

// Call from actions only: mutations use a seeded PRNG, and IVs must be unique.
export const encryptSecret = async (
	plaintext: string,
): Promise<{ iv: string; ciphertext: string }> => {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		await importKey(),
		new TextEncoder().encode(plaintext),
	);
	return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
};

export const decryptSecret = async (secret: {
	iv: string;
	ciphertext: string;
}): Promise<string> => {
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: fromBase64(secret.iv) },
		await importKey(),
		fromBase64(secret.ciphertext),
	);
	return new TextDecoder().decode(plaintext);
};

export const sha256Hex = async (value: string): Promise<string> => {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
};
