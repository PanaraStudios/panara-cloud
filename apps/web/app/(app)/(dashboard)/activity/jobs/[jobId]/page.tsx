import { JobLogView } from "@/components/activity/job-log-view";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Job output" };

export default function Page() {
	const { jobId } = useParams<{ jobId: string }>();
	return <JobLogView jobId={jobId} />;
}
