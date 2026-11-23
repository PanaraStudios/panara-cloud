import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type AccessEntry,
	curlCommand,
	formatDuration,
	RequestBuffer,
	requestHeaders,
	requestLine,
	splitPath,
	statusClass,
} from "./requests.ts";

const request = (at: string, overrides: Partial<AccessEntry> = {}) =>
	({
		StartUTC: at,
		DownstreamStatus: 200,
		ClientAddr: "152.59.40.34:51000",
		ClientHost: "152.59.40.34",
		RequestMethod: "GET",
		RequestHost: "lab.example.test",
		RequestPath: "/api/v4/projects",
		Duration: 60_000_000,
		...overrides,
	}) satisfies AccessEntry;

test("status classes are the four the filter offers", () => {
	assert.equal(statusClass(200), "success");
	assert.equal(statusClass(302), "redirect");
	assert.equal(statusClass(404), "client");
	assert.equal(statusClass(502), "server");
	assert.equal(statusClass(0), null);
	assert.equal(statusClass(101), null);
});

test("durations read in the unit that fits", () => {
	assert.equal(formatDuration(60_000_000), "60ms");
	assert.equal(formatDuration(400_000), "<1ms");
	assert.equal(formatDuration(30_200_000_000), "30.2s");
	assert.equal(formatDuration(undefined), "0ms");
});

test("a path and its query come apart, decoded", () => {
	assert.deepEqual(
		splitPath(
			"/api/v4/projects/acme%2Fstorefront/merge_requests?page=1&per_page=100&source_branch=refactor%2FSHOP-412&flag",
		),
		{
			path: "/api/v4/projects/acme%2Fstorefront/merge_requests",
			query: [
				{ key: "page", value: "1" },
				{ key: "per_page", value: "100" },
				{ key: "source_branch", value: "refactor/SHOP-412" },
				{ key: "flag", value: "" },
			],
		},
	);
	assert.deepEqual(splitPath("/"), { path: "/", query: [] });
	assert.deepEqual(splitPath("/a?b=%E0%A4%A"), {
		path: "/a",
		query: [{ key: "b", value: "%E0%A4%A" }],
	});
});

test("headers Traefik kept are listed under the side they belong to", () => {
	assert.deepEqual(
		requestHeaders(
			request("2026-11-22T06:36:55.407Z", {
				request_User_Agent: "curl/8.5.0",
				request_Content_Type: "",
				downstream_Content_Type: "application/json",
				origin_Content_Type: "application/json",
			}),
		),
		[
			{ group: "request", key: "User-Agent", value: "curl/8.5.0" },
			{ group: "response", key: "Content-Type", value: "application/json" },
			{ group: "upstream", key: "Content-Type", value: "application/json" },
		],
	);
});

test("a request as curl and as one line", () => {
	const entry = request("2026-11-22T06:36:55.407Z", {
		RequestMethod: "POST",
		RequestScheme: "https",
		RequestPath: "/it's",
		request_User_Agent: "it's a bot",
	});
	assert.equal(
		curlCommand(entry),
		"curl -X POST -H 'User-Agent: it'\\''s a bot' 'https://lab.example.test/it'\\''s'",
	);
	assert.equal(
		requestLine(entry),
		"2026-11-22T06:36:55.407Z POST 200 lab.example.test/it's 60ms 152.59.40.34",
	);
});

test("the buffer keeps requests oldest first and each of them once", () => {
	const buffer = new RequestBuffer();
	// A first page comes newest first.
	assert.equal(
		buffer.append([
			request("2026-11-22T06:36:57Z"),
			request("2026-11-22T06:36:56Z"),
			request("2026-11-22T06:36:55Z"),
		]),
		3,
	);
	// The next page starts on the last request held.
	assert.equal(
		buffer.append([
			request("2026-11-22T06:36:57Z"),
			request("2026-11-22T06:36:58.4Z"),
			request("2026-11-22T06:36:58.407Z", { RequestPath: "/later" }),
		]),
		2,
	);
	assert.deepEqual(
		buffer.entries.map((entry) => entry.StartUTC),
		[
			"2026-11-22T06:36:55Z",
			"2026-11-22T06:36:56Z",
			"2026-11-22T06:36:57Z",
			"2026-11-22T06:36:58.4Z",
			"2026-11-22T06:36:58.407Z",
		],
	);
	assert.equal(buffer.append([request("2026-11-22T06:36:57Z")]), 0);
	// Two requests in the same instant from two clients are two requests.
	assert.equal(
		buffer.append([
			request("2026-11-22T06:36:59Z"),
			request("2026-11-22T06:36:59Z", { ClientAddr: "203.0.113.9:4000" }),
		]),
		2,
	);
});

test("older pages go before what is held, and say how many rows moved", () => {
	const buffer = new RequestBuffer();
	buffer.append([request("2026-11-22T06:36:57Z")]);
	assert.equal(
		buffer.prepend([
			request("2026-11-22T06:36:57Z"),
			request("2026-11-22T06:36:50Z"),
			request("2026-11-22T06:36:40Z"),
		]),
		2,
	);
	assert.equal(buffer.prepended, 2);
	assert.equal(buffer.first?.StartUTC, "2026-11-22T06:36:40Z");
	assert.equal(buffer.last?.StartUTC, "2026-11-22T06:36:57Z");
	buffer.clear();
	assert.equal(buffer.prepended, 0);
	assert.deepEqual(buffer.entries, []);
});

test("the buffer drops its oldest requests past its limit and can read them again", () => {
	const buffer = new RequestBuffer(3);
	const page = [1, 2, 3, 4, 5].map((second) =>
		request(`2026-11-22T06:36:0${second}Z`),
	);
	buffer.append(page);
	assert.deepEqual(
		buffer.entries.map((entry) => entry.StartUTC.slice(17, 19)),
		["03", "04", "05"],
	);
	assert.equal(buffer.prepend(page.slice(0, 2)), 2);
});
