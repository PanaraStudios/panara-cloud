// Apache apr1 (MD5-crypt) hashes for Traefik basic auth. Traefik accepts
// bcrypt, apr1 and SHA1; WebCrypto has neither bcrypt nor MD5, so MD5 is
// implemented here to produce salted apr1 hashes in the default runtime.

const S = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
	9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
	16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
	21,
];

const K = Array.from(
	{ length: 64 },
	(_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0,
);

export const md5 = (input: Uint8Array): Uint8Array => {
	const bitLength = input.length * 8;
	const paddedLength = (((input.length + 8) >> 6) + 1) * 64;
	const bytes = new Uint8Array(paddedLength);
	bytes.set(input);
	bytes[input.length] = 0x80;
	const view = new DataView(bytes.buffer);
	view.setUint32(paddedLength - 8, bitLength >>> 0, true);
	view.setUint32(paddedLength - 4, Math.floor(bitLength / 2 ** 32), true);

	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;
	const m = new Uint32Array(16);
	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let j = 0; j < 16; j++) m[j] = view.getUint32(offset + j * 4, true);
		let a = a0;
		let b = b0;
		let c = c0;
		let d = d0;
		for (let i = 0; i < 64; i++) {
			let f: number;
			let g: number;
			if (i < 16) {
				f = (b & c) | (~b & d);
				g = i;
			} else if (i < 32) {
				f = (d & b) | (~d & c);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				f = b ^ c ^ d;
				g = (3 * i + 5) % 16;
			} else {
				f = c ^ (b | ~d);
				g = (7 * i) % 16;
			}
			const sum = (a + f + (K[i] as number) + (m[g] as number)) >>> 0;
			const shift = S[i] as number;
			a = d;
			d = c;
			c = b;
			b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
		}
		a0 = (a0 + a) >>> 0;
		b0 = (b0 + b) >>> 0;
		c0 = (c0 + c) >>> 0;
		d0 = (d0 + d) >>> 0;
	}
	const out = new Uint8Array(16);
	const outView = new DataView(out.buffer);
	outView.setUint32(0, a0, true);
	outView.setUint32(4, b0, true);
	outView.setUint32(8, c0, true);
	outView.setUint32(12, d0, true);
	return out;
};

const ITOA64 =
	"./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const concat = (...parts: Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};

const to64 = (value: number, length: number): string => {
	let out = "";
	let v = value;
	for (let i = 0; i < length; i++) {
		out += ITOA64[v & 0x3f];
		v >>>= 6;
	}
	return out;
};

export const randomSalt = (): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(bytes, (b) => ITOA64[b & 0x3f]).join("");
};

export const apr1 = (password: string, salt: string): string => {
	const encoder = new TextEncoder();
	const pw = encoder.encode(password);
	const saltBytes = encoder.encode(salt.slice(0, 8));
	const magic = encoder.encode("$apr1$");

	let final = md5(concat(pw, saltBytes, pw));
	const parts: Uint8Array[] = [pw, magic, saltBytes];
	for (let pl = pw.length; pl > 0; pl -= 16) {
		parts.push(final.subarray(0, Math.min(pl, 16)));
	}
	for (let i = pw.length; i; i >>= 1) {
		parts.push(i & 1 ? new Uint8Array([0]) : pw.subarray(0, 1));
	}
	final = md5(concat(...parts));

	for (let i = 0; i < 1000; i++) {
		const round: Uint8Array[] = [i & 1 ? pw : final];
		if (i % 3) round.push(saltBytes);
		if (i % 7) round.push(pw);
		round.push(i & 1 ? final : pw);
		final = md5(concat(...round));
	}

	const f = final;
	const b = (i: number) => f[i] as number;
	const encoded =
		to64((b(0) << 16) | (b(6) << 8) | b(12), 4) +
		to64((b(1) << 16) | (b(7) << 8) | b(13), 4) +
		to64((b(2) << 16) | (b(8) << 8) | b(14), 4) +
		to64((b(3) << 16) | (b(9) << 8) | b(15), 4) +
		to64((b(4) << 16) | (b(10) << 8) | b(5), 4) +
		to64(b(11), 2);
	return `$apr1$${salt.slice(0, 8)}$${encoded}`;
};
