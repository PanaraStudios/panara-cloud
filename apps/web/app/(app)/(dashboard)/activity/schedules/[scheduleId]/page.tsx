import type { Metadata } from "next";
import { ScheduleRunsView } from "@/components/activity/schedule-runs-view";

export const metadata: Metadata = { title: "Schedule" };

export default async function Page({
	params,
}: {
	params: Promise<{ scheduleId: string }>;
}) {
	const { scheduleId } = await params;
	return <ScheduleRunsView scheduleId={scheduleId} />;
}
