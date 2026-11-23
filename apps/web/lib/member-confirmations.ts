// What the confirmations of a member's row say (Settings → Members): who the
// action is about, by name and address, and what goes with them.

type Person = { name?: string | null; email: string };

type Confirmation = {
	title: string;
	description: string;
	confirmLabel: string;
};

/** "Ada Lovelace (ada@example.test)"; the address alone for someone who has
    no name, or whose name is the address. */
export function personLabel({ name, email }: Person): string {
	const known = name?.trim();
	return known && known !== email ? `${known} (${email})` : email;
}

/** "Delete user": the membership of one organization. */
export function deleteUserConfirmation(
	person: Person,
	organization: string,
): Confirmation {
	return {
		title: "Delete user?",
		description: `${personLabel(person)} is removed from ${organization}. Their role, their access to its projects and services, and the API keys they made here go with them. Their account stays: they can still sign in, and keep any other organization they belong to.`,
		confirmLabel: "Delete user",
	};
}

/** "Delete account": the account itself, in every organization. */
export function deleteAccountConfirmation(person: Person): Confirmation {
	return {
		title: "Delete account?",
		description: `${personLabel(person)} is deleted for good: their sign-in, sessions, passkeys and two-factor setup, their place in every organization on this panel, and the API keys they made. This can't be undone.`,
		confirmLabel: "Delete account",
	};
}

/** "Deactivate user" and "Reactivate user": the account's sign-in. */
export function deactivationConfirmation(
	person: Person,
	deactivated: boolean,
): Confirmation {
	const who = personLabel(person);
	return deactivated
		? {
				title: "Reactivate user?",
				description: `${who} will be able to sign in again.`,
				confirmLabel: "Reactivate user",
			}
		: {
				title: "Deactivate user?",
				description: `${who} will be signed out everywhere and won't be able to sign in until reactivated.`,
				confirmLabel: "Deactivate user",
			};
}
