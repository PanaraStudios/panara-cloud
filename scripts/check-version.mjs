#!/usr/bin/env node
// The release version lives in the root package.json. A release bumps it
// there; this fails when another place says something else.
//
//   node scripts/check-version.mjs            check the tree
//   node scripts/check-version.mjs v0.1.5     also require this to be the tag
//   node scripts/check-version.mjs --print    print the version
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const version = JSON.parse(read("package.json")).version;

if (process.argv[2] === "--print") {
	console.log(version);
	process.exit(0);
}

const problems = [];
const parse = (value) => {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value ?? "");
	return match ? match.slice(1).map(Number) : null;
};
const compare = (a, b) => {
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return 0;
};

const current = parse(version);
if (!current) {
	problems.push(`package.json: version "${version}" is not x.y.z`);
}

for (const path of [
	"apps/agent/package.json",
	"apps/web/package.json",
	"packages/backend/package.json",
]) {
	const found = JSON.parse(read(path)).version;
	if (found !== version) {
		problems.push(`${path}: version is ${found}, package.json says ${version}`);
	}
}

// The web server's crate carries the release version too.
const crate = /^version = "([^"]+)"/m.exec(
	read("apps/web/server/Cargo.toml"),
)?.[1];
if (crate !== version) {
	problems.push(
		`apps/web/server/Cargo.toml: version is ${crate}, package.json says ${version}`,
	);
}

// CHANGELOG.md: the newest release heading is the last release made. With
// changes waiting under "Unreleased", the version must already be the next
// one, so a channel build is labelled with the release it leads to.
const changelog = read("CHANGELOG.md");
const released = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)\b/gm)].map(
	(match) => match[1],
);
const newest = parse(released[0]);
const unreleased = /^## Unreleased\s*\n([\s\S]*?)(?=^## )/m.exec(changelog);
const pending = unreleased ? /^- /m.test(unreleased[1]) : false;
if (current && newest) {
	if (compare(current, newest) < 0) {
		problems.push(
			`CHANGELOG.md: the newest release is ${released[0]}, after package.json's ${version}`,
		);
	} else if (pending && compare(current, newest) === 0) {
		problems.push(
			`CHANGELOG.md has entries under "Unreleased" but package.json still says ${version}, the release already made: bump the version in package.json and the three workspace package.json files`,
		);
	}
}

const tag = process.argv[2];
if (tag) {
	if (tag.replace(/^v/, "") !== version) {
		problems.push(`Tag ${tag} does not match package.json's ${version}`);
	}
	if (released[0] !== version) {
		problems.push(
			`CHANGELOG.md: no "## ${version} - <date>" heading at the top (newest is ${released[0] ?? "none"})`,
		);
	}
	if (pending) {
		problems.push(
			'CHANGELOG.md: entries are still under "Unreleased"; move them under the release heading',
		);
	}
}

if (problems.length > 0) {
	for (const problem of problems) console.error(`check-version: ${problem}`);
	process.exit(1);
}
console.log(`check-version: ${version}`);
