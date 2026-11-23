import type { Metadata } from "next";
import { JobLogView } from "@/components/activity/job-log-view";

export const metadata: Metadata = { title: "Job output" };

export default async function Page({
	params,
}: {
	params: Promise<{ jobId: string }>;
}) {
	const { jobId } = await params;
	return <JobLogView jobId={jobId} />;
}
