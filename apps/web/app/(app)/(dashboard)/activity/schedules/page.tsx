import type { Metadata } from "next";
import { SchedulesView } from "@/components/activity/schedules-view";

export const metadata: Metadata = { title: "Schedules" };

export default function Page() {
	return <SchedulesView />;
}
