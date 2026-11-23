"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { errorMessage } from "@/lib/auth/errors";

const writtenEvent = (applicationId: string) =>
	`traefik-config-written:${applicationId}`;

export const notifyTraefikConfigWritten = (applicationId: string) => {
	window.dispatchEvent(new Event(writtenEvent(applicationId)));
};

// Reading the file is a job on the application's host; the content arrives
// through the job's op result. Re-reads after a write from this page.
export const useTraefikConfig = (applicationId: string, enabled: boolean) => {
	const read = useMutation(api.applications.traefikConfig.read);
	const [jobId, setJobId] = useState<Id<"jobs"> | null>(null);
	const [requestError, setRequestError] = useState<string | null>(null);
	const [version, setVersion] = useState(0);

	useEffect(() => {
		const bump = () => setVersion((value) => value + 1);
		const name = writtenEvent(applicationId);
		window.addEventListener(name, bump);
		return () => window.removeEventListener(name, bump);
	}, [applicationId]);

	useEffect(() => {
		if (!enabled || !applicationId) return;
		let cancelled = false;
		setRequestError(null);
		read({ applicationId: applicationId as Id<"applications"> })
			.then((id) => {
				if (!cancelled) setJobId(id);
			})
			.catch((error) => {
				if (!cancelled) setRequestError(errorMessage(error));
			});
		return () => {
			cancelled = true;
		};
	}, [applicationId, enabled, read, version]);

	const op = useQuery(api.infra.snapshots.opResult, jobId ? { jobId } : "skip");
	const finished =
		op?.result != null ||
		op?.error != null ||
		op?.status === "failed" ||
		op?.status === "cancelled" ||
		op?.status === "succeeded";
	return {
		data: op?.result ? (JSON.parse(op.result) as string) : null,
		error: requestError ?? op?.error ?? null,
		isPending: enabled && requestError === null && !finished,
		refetch: () => setVersion((value) => value + 1),
	};
};
