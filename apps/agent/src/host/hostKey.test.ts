import type { AddressInfo } from "node:net";
import { type ParsedKey, Server, utils } from "ssh2";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import { connectSsh } from "../live/connection";
import { fingerprint, setHostKeyRecorder } from "./hostKey";
import { SshHost } from "./ssh";

// ssh2 writes about one ed25519 pair in 256 that it can't read back: when the
// public key starts with a zero byte it drops that byte, and `parseKey` then
// refuses both halves ("Malformed OpenSSH private key"). Such a pair made
// this file fail about once in 85 runs, so take the next one. Panara Cloud
// makes its own keys with node:crypto (convex/sources/sshKeygen.ts), not
// with this generator.
const keyPair = () => {
	for (;;) {
		const keys = utils.generateKeyPairSync("ed25519");
		const readable = [keys.private, keys.public].every(
			(text) => !(utils.parseKey(text) instanceof Error),
		);
		if (readable) return keys;
	}
};

const hostKeys = keyPair();
const otherKeys = keyPair();
const clientKeys = keyPair();
const fingerprintOf = (keys: { public: string }) =>
	fingerprint((utils.parseKey(keys.public) as ParsedKey).getPublicSSH());

let server: Server;
let port: number;
let recorded: [string, string][];

beforeAll(async () => {
	server = new Server({ hostKeys: [hostKeys.private] }, (client) => {
		client
			.on("authentication", (ctx) => ctx.accept())
			.on("ready", () => {})
			.on("error", () => {});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
});

afterAll(() => {
	server.close();
	setHostKeyRecorder(null);
});

beforeEach(() => {
	recorded = [];
	setHostKeyRecorder(async (serverId, value) => {
		recorded.push([serverId, value]);
		return true;
	});
});

const target = (hostKey: string | null) => ({
	host: "127.0.0.1",
	port,
	username: "panara",
	privateKey: clientKeys.private,
	serverId: "server1",
	hostKey,
});

describe("SSH host keys", () => {
	test("the first connection records the server's key", async () => {
		const host = await SshHost.connect(target(null));
		host.close();
		expect(recorded).toEqual([["server1", fingerprintOf(hostKeys)]]);
	});

	test("the recorded key is accepted and not recorded again", async () => {
		const host = await SshHost.connect(target(fingerprintOf(hostKeys)));
		host.close();
		const live = await connectSsh(target(fingerprintOf(hostKeys)));
		live.end();
		expect(recorded).toEqual([]);
	});

	test("a different key is refused with a clear error", async () => {
		const expected = fingerprintOf(otherKeys);
		await expect(SshHost.connect(target(expected))).rejects.toThrow(
			/SSH host key of 127\.0\.0\.1:\d+ changed .*reset its host key in the server settings/,
		);
		await expect(connectSsh(target(expected))).rejects.toThrow(/changed/);
		expect(recorded).toEqual([]);
	});

	test("a race where another key was recorded first is refused", async () => {
		setHostKeyRecorder(async () => false);
		await expect(SshHost.connect(target(null))).rejects.toThrow(/changed/);
	});

	test("fingerprints use OpenSSH's SHA256 format", () => {
		expect(fingerprintOf(hostKeys)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
	});
});
