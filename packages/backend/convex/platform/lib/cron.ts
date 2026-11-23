import { ConvexError } from "convex/values";
import { Cron } from "croner";

const isValidTimezone = (timezone: string): boolean => {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone });
		return true;
	} catch {
		return false;
	}
};

// Throws a readable error for an invalid expression or timezone.
export const parseSchedule = (cronExpression: string, timezone?: string) => {
	const tz = timezone?.trim() || "UTC";
	if (!isValidTimezone(tz)) throw new ConvexError(`Unknown timezone "${tz}"`);
	try {
		return new Cron(cronExpression.trim(), { timezone: tz, paused: true });
	} catch (error) {
		throw new ConvexError(
			`Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
};

export const nextRunAfter = (
	cronExpression: string,
	timezone: string | undefined,
	after: number,
): number | null => {
	const next = parseSchedule(cronExpression, timezone).nextRun(new Date(after));
	return next ? next.getTime() : null;
};
