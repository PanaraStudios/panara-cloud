"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { Sandbox } from "@/components/dashboard/sandbox/sandbox-data";
import type { BadgeTone } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { useQueryResult } from "@/lib/host-data";
import { useOrganization } from "@/lib/organization";

export const EXTEND_MS = 30 * 60 * 1000;

/** Re-renders every `interval` ms, for countdowns. */
export function useNow(interval = 1000) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), interval);
		return () => clearInterval(timer);
	}, [interval]);
	return now;
}

/** When a running sandbox stops: its idle expiry, capped by the hard limit. */
export const stopsAt = (sandbox: Sandbox) =>
	Math.min(
		sandbox.expiresAt?.getTime() ?? sandbox.deadlineAt.getTime(),
		sandbox.deadlineAt.getTime(),
	);

export function formatCountdown(ms: number) {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const pad = (value: number) => String(value).padStart(2, "0");
	return hours
		? `${hours}:${pad(minutes)}:${pad(seconds)}`
		: `${pad(minutes)}:${pad(seconds)}`;
}

export function formatDuration(ms: number) {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

export const isLive = (sandbox: Sandbox) =>
	sandbox.status === "running" || sandbox.status === "creating";

export function sandboxStatus(sandbox: Sandbox): {
	tone: BadgeTone;
	label: string;
} {
	switch (sandbox.status) {
		case "running":
			return { tone: "success", label: "Running" };
		case "creating":
			return { tone: "warning", label: "Starting" };
		case "error":
			return { tone: "destructive", label: "Failed" };
		default:
			return {
				tone: "secondary",
				label:
					sandbox.killedAt !== undefined &&
					sandbox.killedAt >= stopsAt(sandbox) - 1000
						? "Expired"
						: "Stopped",
			};
	}
}

export const networkLabel = (sandbox: Sandbox) =>
	sandbox.networkMode === "internet" ? "internet on" : "no internet";

/** Member names by user id, when the viewer may list members (admins). */
export function useMemberNames() {
	const { active } = useOrganization();
	const members = useQueryResult(api.account.members, {
		organizationId: active.id,
	});
	return useMemo(() => {
		const names = new Map<string, string>();
		if (Array.isArray(members)) {
			for (const member of members) {
				names.set(member.userId, member.name || member.email);
			}
		}
		return names;
	}, [members]);
}

/** Pushes a running sandbox's stop time 30 minutes past what's left now. */
export function useExtendSandbox() {
	const updateTimeout = useMutation(api.live.sandboxes.updateTimeout);
	return async (sandbox: Sandbox) => {
		const left = Math.max(0, stopsAt(sandbox) - Date.now());
		try {
			await updateTimeout({
				sandboxId: sandbox.sandboxId as Id<"sandboxes">,
				timeoutMs: Math.min(left + EXTEND_MS, 24 * 60 * 60 * 1000),
			});
			toast.success("Extended by 30 minutes");
		} catch (error) {
			toast.error(errorMessage(error));
		}
	};
}
