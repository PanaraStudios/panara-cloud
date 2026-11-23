// The line of a failed command's output that says why it failed. Node ends an
// uncaught error with its stack and a "Node.js v24.x" banner, and tools end
// with hints and blank lines, so the last line is rarely it.
const NOISE = [
	/^\s*$/,
	/^Node\.js v\d/,
	/^\s+at /,
	/^\s*\^+\s*$/,
	/^\s*[{}[\]],?\s*$/,
	/^file:\/\/\S+:\d+$/,
	/^\s*throw /,
	// The Convex CLI's progress lines: what it was doing, not what went wrong.
	/^\s*(-|▌|✔|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏) /,
];

const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const REASON =
	/(^|\s)(\w*Error|error|✖|failed|refused|denied|not found)\b|^\[migrate\]/i;

export const failureLine = (output) => {
	const lines = String(output ?? "")
		.split("\n")
		.map((line) => line.replace(COLOUR, "").trimEnd())
		.filter((line) => !NOISE.some((pattern) => pattern.test(line)));
	if (lines.length === 0) return null;
	const reason = lines.findLast((line) => REASON.test(line));
	return (reason ?? lines.at(-1)).trim().slice(0, 500);
};
