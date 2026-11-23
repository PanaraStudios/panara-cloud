import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BellIcon,
	CopyIcon,
	ListFilterIcon,
	PlusIcon,
	RocketIcon,
	SaveIcon,
	ScrollTextIcon,
	SquareTerminalIcon,
	Trash2Icon,
} from "lucide-react";
import { createElement } from "react";
import { actionIcon, plainLabel } from "./action-icons.ts";

test("an action gets the icon of its verb", () => {
	assert.equal(actionIcon("Deploy"), RocketIcon);
	assert.equal(actionIcon("Deploy 2 changes"), RocketIcon);
	assert.equal(actionIcon("Save ports"), SaveIcon);
	assert.equal(actionIcon("Add domain"), PlusIcon);
	assert.equal(actionIcon("Delete project…"), Trash2Icon);
});

test("a later word can decide the icon", () => {
	assert.equal(actionIcon("View logs"), ScrollTextIcon);
	assert.equal(actionIcon("Open terminal"), SquareTerminalIcon);
});

test("labels that are no verb still find their icon", () => {
	assert.equal(actionIcon("Errors only"), ListFilterIcon);
	assert.equal(actionIcon("Notification channels"), BellIcon);
	assert.equal(actionIcon("Force remove"), Trash2Icon);
	assert.equal(actionIcon("Get command"), SquareTerminalIcon);
	assert.equal(actionIcon("Create only"), PlusIcon);
	assert.equal(actionIcon("Copy command"), CopyIcon);
});

test("a label in progress keeps the icon of its action", () => {
	assert.equal(actionIcon("Saving…"), SaveIcon);
	assert.equal(actionIcon("Creating..."), PlusIcon);
});

test("leaving a dialog and unknown labels get no icon", () => {
	for (const label of ["Cancel", "Close", "Done", "Next", "Last 3 days", ""]) {
		assert.equal(actionIcon(label), null);
	}
	assert.notEqual(actionIcon("Cancel invitation"), null);
});

test("only text-only children count as a label", () => {
	assert.equal(plainLabel("Deploy"), "Deploy");
	assert.equal(plainLabel(["Deploy ", 2, " changes"]), "Deploy 2 changes");
	assert.equal(plainLabel(["Deploy", createElement("svg")]), null);
	assert.equal(plainLabel(null), null);
});
