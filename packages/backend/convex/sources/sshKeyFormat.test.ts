import { expect, test } from "vitest";
import { openSshPrivateKey, openSshPublicKey } from "./sshKeyFormat";

const b64 = (value: string) =>
	Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

// A throwaway key from `ssh-keygen -t ed25519 -N "" -C panara`.
const FIXTURE = {
	checkint: 2361401306,
	publicKey: b64("Roxj0Cmo2FvMCNcXwAWGK+3KRqXl4H+g+lMZyaWxcG4="),
	seed: b64("mmIj21wu4dr7S1r7PFSv8yex/+EiKbhw9tBGEk1UulM="),
	private:
		"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACBGjGPQKajYW8wI1xfABYYr7cpGpeXgf6D6UxnJpbFwbgAAAJCMwB/ajMAf\n2gAAAAtzc2gtZWQyNTUxOQAAACBGjGPQKajYW8wI1xfABYYr7cpGpeXgf6D6UxnJpbFwbg\nAAAECaYiPbXC7h2vtLWvs8VK/zJ7H/4SIpuHD20EYSTVS6U0aMY9ApqNhbzAjXF8AFhivt\nykal5eB/oPpTGcmlsXBuAAAABnBhbmFyYQECAwQFBgc=\n-----END OPENSSH PRIVATE KEY-----\n",
	public:
		"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEaMY9ApqNhbzAjXF8AFhivtykal5eB/oPpTGcmlsXBu panara",
};

test("ed25519 keys match ssh-keygen byte for byte", () => {
	const key = {
		type: "ed25519" as const,
		publicKey: FIXTURE.publicKey,
		seed: FIXTURE.seed,
	};
	expect(openSshPublicKey(key, "panara")).toBe(FIXTURE.public);
	expect(openSshPrivateKey(key, "panara", FIXTURE.checkint)).toBe(
		FIXTURE.private,
	);
});

test("RSA public keys encode e and n as mpints", () => {
	const n = new Uint8Array(256).fill(0xff);
	const key = {
		type: "rsa" as const,
		n,
		e: new Uint8Array([1, 0, 1]),
		d: n,
		p: n,
		q: n,
		qi: n,
	};
	const blob = b64(openSshPublicKey(key, "").split(" ")[1] ?? "");
	// "ssh-rsa" (4+7), e (4+3), n with a leading zero byte (4+257).
	expect(blob.length).toBe(11 + 7 + 261);
	expect(Array.from(blob.subarray(18, 23))).toEqual([0, 0, 1, 1, 0]);
	expect(openSshPrivateKey(key, "c", 7)).toMatch(
		/^-----BEGIN OPENSSH PRIVATE KEY-----\n/,
	);
});
