import { describe, expect, test } from "vitest";
import {
	directoryExportCommand,
	directoryImportCommand,
	formatBytes,
	pipeBetweenHosts,
	volumeExportCommand,
	volumeImportCommand,
} from "./transfer";

describe("transfer commands", () => {
	test("quote names and keep owners", () => {
		expect(volumeExportCommand("data vol")).toContain("-v 'data vol:/data:ro'");
		expect(volumeImportCommand("v1")).toMatch(
			/^\$DOCKER volume create v1 >\/dev\/null && .* tar -xzf - --numeric-owner -C \/data$/,
		);
		expect(directoryExportCommand("/srv/a b")).toBe(
			"$SUDO tar -czf - --numeric-owner -C '/srv/a b' .",
		);
		expect(directoryImportCommand("/srv/x")).toBe(
			"$SUDO mkdir -p /srv/x && $SUDO tar -xzf - --numeric-owner -C /srv/x",
		);
		expect(formatBytes(512)).toBe("0.5 KiB");
		expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GiB");
	});

	test("pipes bytes between local commands and reports failures of either side", async () => {
		const local = { type: "local" as const };
		const bytes = await pipeBetweenHosts({
			source: { target: local, command: "printf 'hello world'" },
			target: { target: local, command: "test \"$(cat)\" = 'hello world'" },
		});
		expect(bytes).toBe(11);
		await expect(
			pipeBetweenHosts({
				source: { target: local, command: "echo boom >&2; exit 3" },
				target: { target: local, command: "cat >/dev/null" },
			}),
		).rejects.toThrow(/source exited with code 3: boom/);
		await expect(
			pipeBetweenHosts({
				source: { target: local, command: "yes | head -c 100000" },
				target: { target: local, command: "echo nope >&2; exit 4" },
			}),
		).rejects.toThrow(/target exited with code 4: nope/);
	});

	test("an abort stops both sides", async () => {
		const local = { type: "local" as const };
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		await expect(
			pipeBetweenHosts({
				source: { target: local, command: "sleep 30; echo late" },
				target: { target: local, command: "cat >/dev/null" },
				signal: controller.signal,
			}),
		).rejects.toThrow(/Cancelled/);
	});
});
