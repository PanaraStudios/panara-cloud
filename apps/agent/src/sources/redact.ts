const MIN_SECRET_LENGTH = 4;

// Removes secrets and URL userinfo (https://user:token@host) from text that
// is about to be logged or reported.
export const redact = (
	text: string,
	secrets: (string | undefined | null)[] = [],
) => {
	let result = text.replace(
		/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi,
		"$1***@",
	);
	for (const secret of secrets) {
		if (secret && secret.length >= MIN_SECRET_LENGTH) {
			result = result.split(secret).join("***");
		}
	}
	return result;
};
