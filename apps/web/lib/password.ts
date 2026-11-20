// Mirrors emailAndPassword.minPasswordLength/maxPasswordLength in
// packages/backend/convex/authOptions.ts.
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

export function passwordProblem(password: string, confirm?: string) {
	if (password.length < MIN_PASSWORD_LENGTH) {
		return `Use a password with at least ${MIN_PASSWORD_LENGTH} characters.`;
	}
	if (password.length > MAX_PASSWORD_LENGTH) {
		return `Use a password with at most ${MAX_PASSWORD_LENGTH} characters.`;
	}
	if (confirm !== undefined && confirm !== password) {
		return "The passwords don't match.";
	}
	return null;
}
