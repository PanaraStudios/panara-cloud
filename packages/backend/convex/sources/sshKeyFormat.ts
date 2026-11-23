// OpenSSH key encoding (PROTOCOL.key / RFC 4253) for generated keypairs.
// ssh2 and OpenSSH both read "openssh-key-v1" private keys, which Node's
// crypto can't export directly.

const encoder = new TextEncoder();

const concat = (parts: Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};

const uint32 = (value: number) => {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, value >>> 0);
	return out;
};

const sshString = (value: Uint8Array | string) => {
	const bytes = typeof value === "string" ? encoder.encode(value) : value;
	return concat([uint32(bytes.length), bytes]);
};

// Unsigned big-endian integer as an SSH mpint: no leading zeros, plus one
// zero byte when the high bit is set so it stays positive.
const mpint = (value: Uint8Array) => {
	let start = 0;
	while (start < value.length && value[start] === 0) start++;
	const trimmed = value.subarray(start);
	if (trimmed.length === 0) return sshString(new Uint8Array());
	const needsPad = ((trimmed[0] as number) & 0x80) !== 0;
	return sshString(needsPad ? concat([new Uint8Array([0]), trimmed]) : trimmed);
};

export const base64 = (bytes: Uint8Array) => {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
};

export const fromBase64Url = (value: string): Uint8Array => {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/");
	return Uint8Array.from(
		atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)),
		(c) => c.charCodeAt(0),
	);
};

export type KeyMaterial =
	| { type: "ed25519"; publicKey: Uint8Array; seed: Uint8Array }
	| {
			type: "rsa";
			n: Uint8Array;
			e: Uint8Array;
			d: Uint8Array;
			p: Uint8Array;
			q: Uint8Array;
			qi: Uint8Array;
	  };

const publicBlob = (key: KeyMaterial) =>
	key.type === "ed25519"
		? concat([sshString("ssh-ed25519"), sshString(key.publicKey)])
		: concat([sshString("ssh-rsa"), mpint(key.e), mpint(key.n)]);

const keyName = (key: KeyMaterial) =>
	key.type === "ed25519" ? "ssh-ed25519" : "ssh-rsa";

export const openSshPublicKey = (key: KeyMaterial, comment: string) =>
	`${keyName(key)} ${base64(publicBlob(key))}${comment ? ` ${comment}` : ""}`;

export const openSshPrivateKey = (
	key: KeyMaterial,
	comment: string,
	checkint: number,
): string => {
	const privateFields =
		key.type === "ed25519"
			? [sshString(key.publicKey), sshString(concat([key.seed, key.publicKey]))]
			: [
					mpint(key.n),
					mpint(key.e),
					mpint(key.d),
					mpint(key.qi),
					mpint(key.p),
					mpint(key.q),
				];
	const unpadded = concat([
		uint32(checkint),
		uint32(checkint),
		sshString(keyName(key)),
		...privateFields,
		sshString(comment),
	]);
	const padding = new Uint8Array((8 - (unpadded.length % 8)) % 8).map(
		(_, i) => i + 1,
	);
	const body = concat([
		encoder.encode("openssh-key-v1\0"),
		sshString("none"),
		sshString("none"),
		sshString(""),
		uint32(1),
		sshString(publicBlob(key)),
		sshString(concat([unpadded, padding])),
	]);
	const lines = base64(body).match(/.{1,70}/g) ?? [];
	return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
};
