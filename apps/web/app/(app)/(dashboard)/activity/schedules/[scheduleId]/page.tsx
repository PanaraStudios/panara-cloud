import { ScheduleRunsView } from "@/components/activity/schedule-runs-view";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Schedule" };

export default function Page() {
	const { scheduleId } = useParams<{ scheduleId: string }>();
	return <ScheduleRunsView scheduleId={scheduleId} />;
}
