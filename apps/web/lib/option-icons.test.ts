import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ArrowDownAZIcon,
	ArrowDownZAIcon,
	AsteriskIcon,
	CalendarArrowDownIcon,
	CalendarArrowUpIcon,
	CalendarDaysIcon,
	ClockIcon,
	HistoryIcon,
	KeyRoundIcon,
	PackageIcon,
	ServerIcon,
	SquareTerminalIcon,
	TerminalIcon,
	TextAlignStartIcon,
	TimerIcon,
} from "lucide-react";
import { nameMark, optionMark, optionMarks } from "./option-icons.ts";

test("a sort order gets the glyph of what it sorts by", () => {
	assert.deepEqual(optionMark("Last activity"), { glyph: HistoryIcon });
	assert.deepEqual(optionMark("Name"), { glyph: ArrowDownAZIcon });
	assert.deepEqual(optionMark("Newest"), { glyph: CalendarArrowDownIcon });
	assert.deepEqual(optionMark("Oldest first"), { glyph: CalendarArrowUpIcon });
	assert.deepEqual(optionMark("Type (Z-A)"), { glyph: ArrowDownZAIcon });
});

test("a brand gets its logo and a status its colour", () => {
	assert.deepEqual(optionMark("PostgreSQL"), { brand: "postgres" });
	assert.deepEqual(optionMark("GitHub"), { brand: "github" });
	assert.deepEqual(optionMark("Docker Compose"), { brand: "docker" });
	assert.deepEqual(optionMark("Live"), { tone: "success" });
	assert.deepEqual(optionMark("Deploying"), { tone: "info" });
	assert.deepEqual(optionMark("Failed"), { tone: "destructive" });
	assert.deepEqual(optionMark("running"), { tone: "success" });
	assert.deepEqual(optionMark("Not deployed"), { tone: "secondary" });
});

test("a span of time carries its unit", () => {
	assert.deepEqual(optionMark("Last 15 minutes"), { glyph: TimerIcon });
	assert.deepEqual(optionMark("Last hour"), { glyph: ClockIcon });
	assert.deepEqual(optionMark("24h"), { glyph: ClockIcon });
	assert.deepEqual(optionMark("7 days"), { glyph: CalendarDaysIcon });
	assert.equal(optionMark("hour"), null);
});

test("the note after a name doesn't change what it is", () => {
	assert.deepEqual(optionMark("All statuses"), { glyph: AsteriskIcon });
	assert.deepEqual(optionMark("All 7"), { glyph: AsteriskIcon });
	assert.deepEqual(
		optionMark("Member · only granted projects"),
		optionMark("Member"),
	);
	assert.deepEqual(optionMark("Let’s Encrypt"), optionMark("Let's Encrypt"));
});

test("data gets no mark", () => {
	for (const label of [
		"storefront",
		"production",
		"fr-par",
		"postgres:18",
		"50 points",
		"AAAA",
		"web-1",
		"",
	]) {
		assert.equal(optionMark(label), null);
	}
});

test("a list is marked whole or not at all", () => {
	assert.equal(optionMarks(["All projects", "storefront", "Redis"]), null);
	assert.equal(
		optionMarks(["Last activity", "Name", "Newest"])?.every(Boolean),
		true,
	);
	assert.equal(optionMarks([]), null);
});

test("a list whose rows would repeat one mark stays bare", () => {
	assert.equal(optionMarks(["5 Seconds", "10 Seconds", "30 Seconds"]), null);
	assert.notEqual(optionMarks(["Live", "15 min", "1 h"]), null);
	assert.notEqual(optionMarks(["Timestamps"]), null);
});

test("rows with a mark of their own don't decide for the rest", () => {
	const marks = optionMarks(["All", undefined, "Running"]);
	assert.deepEqual(marks, [{ glyph: AsteriskIcon }, null, { tone: "success" }]);
	assert.equal(optionMarks([undefined, undefined]), null);
});

test("a list of names carries the mark of what it lists", () => {
	assert.deepEqual(optionMarks(["All", "storefront", "internal"], "project"), [
		{ glyph: AsteriskIcon },
		{ monogram: "s" },
		{ monogram: "i" },
	]);
	assert.deepEqual(optionMarks(["Panara Cloud host", "web-1"], "server"), [
		{ brand: "panel" },
		{ glyph: ServerIcon },
	]);
	// Every row the same glyph is fine here: the list said what it lists.
	assert.deepEqual(optionMarks(["web-1", "web-2"], "server"), [
		{ glyph: ServerIcon },
		{ glyph: ServerIcon },
	]);
	assert.deepEqual(optionMarks(["ghcr", undefined], "registry"), [
		{ glyph: PackageIcon },
		null,
	]);
	assert.equal(optionMarks([], "server"), null);
});

test("a name is never read as a status or a type", () => {
	assert.deepEqual(nameMark("server", "Live"), { glyph: ServerIcon });
	assert.deepEqual(nameMark("sshKey", "deploy"), { glyph: KeyRoundIcon });
	assert.deepEqual(nameMark("project", "  42 things"), { monogram: "4" });
	assert.deepEqual(nameMark("registry", "None"), optionMark("None"));
	assert.deepEqual(nameMark("email", "Panara Cloud (built-in)"), {
		brand: "panel",
	});
});

test("shells and swarm modes have a mark", () => {
	assert.deepEqual(optionMark("/bin/bash"), { glyph: SquareTerminalIcon });
	assert.deepEqual(optionMark("Sh"), { glyph: TerminalIcon });
	// A choice between the two is a marked list, however they are written.
	assert.notEqual(optionMarks(["Bash", "Sh"]), null);
	assert.notEqual(optionMarks(["/bin/bash", "/bin/sh"]), null);
	assert.notEqual(optionMarks(["Bash", "/bin/sh"]), null);
	assert.notEqual(optionMarks(["Replicated", "Global"]), null);
	assert.notEqual(optionMarks(["VIP (virtual IP)", "DNS round robin"]), null);
});

test("amounts of one kind carry that kind's mark", () => {
	// "Lines loaded" in the logs' Since menu: numbers have no mark of their own.
	assert.equal(optionMarks(["100", "500", "1,000", "10,000"]), null);
	assert.deepEqual(optionMarks(["100", "1,000", "10,000"], "lines"), [
		{ glyph: TextAlignStartIcon },
		{ glyph: TextAlignStartIcon },
		{ glyph: TextAlignStartIcon },
	]);
});

test("the breadcrumb's switchers mark every project and server", () => {
	assert.deepEqual(nameMark("project", "storefront"), { monogram: "s" });
	assert.deepEqual(nameMark("server", "Panara Cloud host"), { brand: "panel" });
	assert.deepEqual(nameMark("server", "build-1"), { glyph: ServerIcon });
});
