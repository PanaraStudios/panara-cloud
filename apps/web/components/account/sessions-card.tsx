"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import { StatusDot } from "@/components/settings/form-kit";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { ResourceTable, Th } from "@/components/ui-kit/primitives";
import { ActionFeedback, formatDate, useAction } from "./shared";

export function describeDevice(userAgent?: string | null) {
	const ua = userAgent ?? "";
	const browser = /Edg\//.test(ua)
		? "Edge"
		: /OPR\//.test(ua)
			? "Opera"
			: /Firefox\//.test(ua)
				? "Firefox"
				: /HeadlessChrome\//.test(ua)
					? "Headless Chrome"
					: /Chrome\//.test(ua)
						? "Chrome"
						: /Safari\//.test(ua)
							? "Safari"
							: "Unknown browser";
	const os = /iPhone|iPad/.test(ua)
		? "iOS"
		: /Android/.test(ua)
			? "Android"
			: /Mac OS X/.test(ua)
				? "macOS"
				: /Windows/.test(ua)
					? "Windows"
					: /Linux/.test(ua)
						? "Linux"
						: "Unknown OS";
	return {
		label: `${browser} on ${os}`,
		mobile: /iPhone|iPad|Android|Mobile/.test(ua),
	};
}

function relative(ms: number) {
	const diff = Date.now() - ms;
	if (diff < 2 * 60_000) return "Now";
	const minutes = Math.round(diff / 60_000);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.round(hours / 24);
	return days === 1 ? "Yesterday" : `${days} days ago`;
}

/** Account › Sessions: every signed-in browser, newest activity first. */
export function SessionsPage() {
	// Served by Convex without session tokens, so it works on any session
	// (Better Auth's /list-sessions needs a sign-in from the last 5 minutes)
	// and stays live: a device signing in or out shows up immediately.
	const sessions = useQuery(api.account.sessions);
	const revokeSession = useMutation(api.account.revokeSession);
	const revokeOtherSessions = useMutation(api.account.revokeOtherSessions);
	const action = useAction();
	const others = sessions?.filter((session) => !session.current) ?? [];

	return (
		<div className="flex w-full flex-col gap-6">
			<div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2">
				<h2 className="sr-only">Sessions</h2>
				<p className="min-w-0 flex-1 text-muted-foreground text-sm">
					Browsers signed in to your account. Sign out anything you don't
					recognise.
				</p>
				{others.length > 0 && (
					<Button
						variant="outline"
						disabled={action.pending}
						onClick={() =>
							action.run(async () => {
								await revokeOtherSessions();
								return "Signed out of all other sessions.";
							})
						}
					>
						Sign out all other sessions
					</Button>
				)}
			</div>
			<ActionFeedback error={action.error} success={action.success} />
			<ResourceTable
				headers={
					<>
						<Th>Device</Th>
						<Th>Signed in</Th>
						<Th>Last active</Th>
						<Th className="w-28" />
					</>
				}
			>
				{sessions === undefined ? (
					<TableRow>
						<TableCell colSpan={4} className="text-muted-foreground">
							Loading…
						</TableCell>
					</TableRow>
				) : null}
				{sessions?.map((session) => {
					const device = describeDevice(session.userAgent);
					return (
						<TableRow key={session.id}>
							<TableCell className="font-medium">
								<span className="flex items-center gap-3">
									{device.label}
									{session.current && (
										<StatusDot
											tone="success"
											className="font-normal text-muted-foreground"
										>
											This device
										</StatusDot>
									)}
								</span>
							</TableCell>
							<TableCell className="text-muted-foreground">
								{formatDate(session.createdAt)}
							</TableCell>
							<TableCell
								className={session.current ? "" : "text-muted-foreground"}
							>
								{session.current ? "Now" : relative(session.updatedAt)}
							</TableCell>
							<TableCell className="text-right">
								{!session.current && (
									<Button
										variant="outline"
										size="sm"
										disabled={action.pending}
										aria-label={`Sign out ${device.label} session`}
										onClick={() =>
											action.run(async () => {
												await revokeSession({ sessionId: session.id });
												return `Signed out ${device.label}.`;
											})
										}
									>
										Sign out
									</Button>
								)}
							</TableCell>
						</TableRow>
					);
				})}
			</ResourceTable>
		</div>
	);
}
