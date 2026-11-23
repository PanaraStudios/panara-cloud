import type { api } from "@panara-cloud/backend/api";
import type { FunctionReturnType } from "convex/server";
import type { useDirectory } from "./use-directory";

export type Schedule = FunctionReturnType<
	typeof api.platform.schedules.listForOrganization
>["page"][number];
export type ScheduleRun = FunctionReturnType<
	typeof api.platform.schedules.runs
>[number];

export const PANEL_HOST = "Panara Cloud host";

const DAYS = [
	"Sundays",
	"Mondays",
	"Tuesdays",
	"Wednesdays",
	"Thursdays",
	"Fridays",
	"Saturdays",
];

const time = (hour: string, minute: string) =>
	`${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;

const isNumber = (value: string | undefined): value is string =>
	value !== undefined && /^\d+$/.test(value);

/** Plain words for the common cron shapes; null when it isn't one. */
export function describeCron(expression: string): string | null {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) return null;
	const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
	const everyDay = dayOfMonth === "*" && month === "*";
	if (!everyDay) {
		if (
			isNumber(minute) &&
			isNumber(hour) &&
			isNumber(dayOfMonth) &&
			month === "*" &&
			dayOfWeek === "*"
		)
			return `Monthly on day ${dayOfMonth} at ${time(hour, minute)}`;
		return null;
	}
	if (minute === "*" && hour === "*" && dayOfWeek === "*")
		return "Every minute";
	const step = minute?.match(/^\*\/(\d+)$/);
	if (step && hour === "*" && dayOfWeek === "*") return `Every ${step[1]} min`;
	if (isNumber(minute) && hour === "*" && dayOfWeek === "*")
		return minute === "0"
			? "Every hour"
			: `Hourly at :${minute.padStart(2, "0")}`;
	const hourStep = hour?.match(/^\*\/(\d+)$/);
	if (isNumber(minute) && hourStep && dayOfWeek === "*")
		return `Every ${hourStep[1]} hours`;
	if (isNumber(minute) && isNumber(hour)) {
		if (dayOfWeek === "*") return `Daily at ${time(hour, minute)}`;
		if (isNumber(dayOfWeek) && Number(dayOfWeek) <= 7)
			return `${DAYS[Number(dayOfWeek) % 7]} at ${time(hour, minute)}`;
		if (dayOfWeek === "1-5") return `Weekdays at ${time(hour, minute)}`;
	}
	return null;
}

const clock = (at: Date) =>
	at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** "14:30", "Tomorrow 03:00", "Sun 02:00", or a date further out. */
export function formatWhen(timestamp: number, now = Date.now()) {
	const at = new Date(timestamp);
	const today = new Date(now);
	const startOfDay = (date: Date) =>
		new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	const days = Math.round((startOfDay(at) - startOfDay(today)) / 86_400_000);
	if (days === 0) return clock(at);
	if (days === 1) return `Tomorrow ${clock(at)}`;
	if (days === -1) return `Yesterday ${clock(at)}`;
	if (Math.abs(days) < 7)
		return `${at.toLocaleDateString([], { weekday: "short" })} ${clock(at)}`;
	return at.toLocaleString([], {
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** "Today 14:00" for the run list. */
export function formatRunTime(timestamp: number, now = Date.now()) {
	const label = formatWhen(timestamp, now);
	return /^\d/.test(label) ? `Today ${label}` : label;
}

export const runTone = (status: ScheduleRun["status"]) =>
	status === "succeeded"
		? ("success" as const)
		: status === "failed"
			? ("destructive" as const)
			: status === "cancelled"
				? ("secondary" as const)
				: ("info" as const);

export const runLabel = (status: ScheduleRun["status"]) =>
	status === "succeeded"
		? "Succeeded"
		: status === "failed"
			? "Failed"
			: status === "cancelled"
				? "Cancelled"
				: status === "queued"
					? "Queued"
					: "Running";

export const runDuration = (run: ScheduleRun) =>
	run.startedAt && run.finishedAt ? run.finishedAt - run.startedAt : null;

/** Where a schedule runs: "project / service", or the host's name. */
export function scheduleTarget(
	schedule: Schedule,
	directory: ReturnType<typeof useDirectory>,
) {
	switch (schedule.target.kind) {
		case "application":
		case "compose": {
			const service = directory.byId.get(schedule.targetId);
			const label = service
				? `${service.projectName} / ${service.name}`
				: "Deleted service";
			return {
				label,
				note:
					schedule.target.kind === "compose"
						? `service ${schedule.target.serviceName}`
						: undefined,
				href: service?.href ?? null,
				isHost: false,
			};
		}
		case "server":
			return {
				label: directory.serverNames.get(schedule.targetId) ?? "Server",
				note: "server · host shell",
				href: `/servers/${schedule.targetId}`,
				isHost: true,
			};
		case "panel":
			return {
				label: PANEL_HOST,
				note: "panel host · host shell",
				href: "/servers/local",
				isHost: true,
			};
	}
}

export const scheduleFormType = (schedule: Schedule) =>
	schedule.target.kind === "panel" ? ("panel" as const) : schedule.target.kind;

export const scheduleFormId = (schedule: Schedule) =>
	schedule.target.kind === "panel" ? "panel" : schedule.targetId;
