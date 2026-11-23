import { SchedulesView } from "@/components/activity/schedules-view";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Schedules" };

export default function Page() {
	return <SchedulesView />;
}
