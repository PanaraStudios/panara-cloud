import assert from "node:assert/strict";
import { test } from "node:test";
import {
	deactivationConfirmation,
	deleteAccountConfirmation,
	deleteUserConfirmation,
	personLabel,
} from "./member-confirmations.ts";

const ada = { name: "Ada Lovelace", email: "ada@example.test" };

test("a person is called by name and address", () => {
	assert.equal(personLabel(ada), "Ada Lovelace (ada@example.test)");
});

test("someone without a name is called by their address, once", () => {
	for (const name of [undefined, null, "", "  ", "ada@example.test"]) {
		assert.equal(
			personLabel({ name, email: "ada@example.test" }),
			"ada@example.test",
		);
	}
});

test("every confirmation of a member's row names who it is about", () => {
	const confirmations = [
		deleteUserConfirmation(ada, "Storefront"),
		deleteAccountConfirmation(ada),
		deactivationConfirmation(ada, false),
		deactivationConfirmation(ada, true),
	];
	for (const { title, description, confirmLabel } of confirmations) {
		assert.match(description, /^Ada Lovelace \(ada@example\.test\) /);
		// The button repeats the action, not "Confirm".
		assert.equal(title, `${confirmLabel}?`);
	}
});

test("deleting a user says which organization and that the account stays", () => {
	const { description } = deleteUserConfirmation(ada, "Storefront");
	assert.match(description, /is removed from Storefront\./);
	assert.match(description, /API keys they made here/);
	assert.match(description, /Their account stays/);
});

test("deleting an account says it is everywhere and for good", () => {
	const { description } = deleteAccountConfirmation(ada);
	assert.match(description, /every organization on this panel/);
	assert.match(description, /passkeys and two-factor/);
	assert.match(description, /can't be undone/);
});
