import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesShortcut, type ShortcutKey } from "./dashboard/shortcuts.ts";

const press = (key: string, held: Partial<ShortcutKey> = {}): ShortcutKey => ({
	key,
	metaKey: false,
	ctrlKey: false,
	altKey: false,
	shiftKey: false,
	repeat: false,
	isComposing: false,
	keyCode: 0,
	...held,
});

test("a shortcut that names Shift needs it, and only it", () => {
	assert.equal(
		matchesShortcut(press("R", { shiftKey: true }), "shift+r", false),
		true,
	);
	assert.equal(matchesShortcut(press("r"), "shift+r", false), false);
	assert.equal(
		matchesShortcut(
			press("R", { shiftKey: true, ctrlKey: true }),
			"shift+r",
			false,
		),
		false,
	);
});

test("a plain key ignores presses with Shift held", () => {
	assert.equal(matchesShortcut(press("c"), "c", false), true);
	assert.equal(
		matchesShortcut(press("C", { shiftKey: true }), "c", false),
		false,
	);
	assert.equal(
		matchesShortcut(press("?", { shiftKey: true }), "?", false),
		true,
	);
});

test("mod is Command on a Mac and Control elsewhere", () => {
	assert.equal(
		matchesShortcut(press("s", { metaKey: true }), "mod+s", true),
		true,
	);
	assert.equal(
		matchesShortcut(press("s", { ctrlKey: true }), "mod+s", true),
		false,
	);
	assert.equal(
		matchesShortcut(press("s", { ctrlKey: true }), "mod+s", false),
		true,
	);
	assert.equal(
		matchesShortcut(press("Enter", { ctrlKey: true }), "mod+Enter", false),
		true,
	);
});
