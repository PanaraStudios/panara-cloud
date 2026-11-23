import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { agentVersion } from "./infra/panel";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const FILES = [
	"package.json",
	"apps/agent/package.json",
	"apps/web/package.json",
	"packages/backend/package.json",
	"apps/web/server/Cargo.toml",
	"CHANGELOG.md",
	"scripts/check-version.mjs",
];

// Runs scripts/check-version.mjs on a copy of the files it reads, after
// `edit` changed some of them.
const check = (
	edit: (
		file: (path: string, change: (text: string) => string) => void,
	) => void,
	args: string[] = [],
) => {
	const dir = mkdtempSync(join(tmpdir(), "check-version-"));
	for (const path of FILES) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		cpSync(join(repo, path), join(dir, path));
	}
	edit((path, change) =>
		writeFileSync(
			join(dir, path),
			change(readFileSync(join(dir, path), "utf8")),
		),
	);
	const result = spawnSync(
		"node",
		[join(dir, "scripts/check-version.mjs"), ...args],
		{ encoding: "utf8" },
	);
	rmSync(dir, { recursive: true, force: true });
	return { status: result.status, output: result.stdout + result.stderr };
};

const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"))
	.version as string;

describe("release version", () => {
	test("every place in the tree agrees", () => {
		const result = check(() => {});
		expect(result.output).toBe(`check-version: ${version}\n`);
		expect(result.status).toBe(0);
		expect(agentVersion()).toBe(version);
	});

	test("a workspace package.json left behind fails", () => {
		const result = check((file) =>
			file("apps/agent/package.json", (text) =>
				text.replace(`"version": "${version}"`, '"version": "0.1.0"'),
			),
		);
		expect(result.status).toBe(1);
		expect(result.output).toContain(
			`apps/agent/package.json: version is 0.1.0, package.json says ${version}`,
		);
	});

	test("the web server's crate left behind fails", () => {
		const result = check((file) =>
			file("apps/web/server/Cargo.toml", (text) =>
				text.replace(`version = "${version}"`, 'version = "0.1.0"'),
			),
		);
		expect(result.status).toBe(1);
		expect(result.output).toContain(
			`apps/web/server/Cargo.toml: version is 0.1.0, package.json says ${version}`,
		);
	});

	test("unreleased changes on the version of the last release fail", () => {
		const result = check((file) =>
			file("CHANGELOG.md", (text) =>
				text.replace(
					/^## Unreleased$/m,
					`## Unreleased\n\n- Something new.\n\n## ${version} - 2026-01-01`,
				),
			),
		);
		expect(result.status).toBe(1);
		expect(result.output).toContain('entries under "Unreleased"');
	});

	test("a tag must be the version, with its changelog heading", () => {
		const released = (file: Parameters<Parameters<typeof check>[0]>[0]) =>
			file("CHANGELOG.md", (text) =>
				text.replace(/^## Unreleased$/m, `## ${version} - 2026-01-01`),
			);
		expect(check(released, [`v${version}`]).status).toBe(0);
		const wrong = check(released, ["v9.9.9"]);
		expect(wrong.status).toBe(1);
		expect(wrong.output).toContain(
			`Tag v9.9.9 does not match package.json's ${version}`,
		);
		const early = check(
			(file) =>
				file("CHANGELOG.md", (text) =>
					text
						.replace(new RegExp(`^## ${version} - .*\\n`, "m"), "")
						.replace(/^## Unreleased$/m, "## Unreleased\n\n- Pending."),
				),
			[`v${version}`],
		);
		expect(early.status).toBe(1);
		expect(early.output).toContain(`no "## ${version} - <date>" heading`);
	});

	test("the release workflow takes the version from the same place", () => {
		const workflow = readFileSync(
			join(repo, ".github/workflows/release-images.yml"),
			"utf8",
		);
		expect(workflow).toContain(
			'node scripts/check-version.mjs "$GITHUB_REF_NAME"',
		);
		expect(workflow).toContain(
			"base=$(node scripts/check-version.mjs --print)",
		);
		expect(workflow).not.toContain("apps/agent/package.json");
	});
});
