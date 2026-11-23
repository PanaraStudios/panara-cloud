"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { formatDistanceToNowStrict } from "date-fns";
import {
	ArrowUpRightIcon,
	OctagonXIcon,
	SquareDashedIcon,
	TimerResetIcon,
	Trash2Icon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import {
	AddSandbox,
	NewSandboxForm,
} from "@/components/dashboard/sandbox/add-sandbox";
import {
	type Sandbox,
	toSandbox,
} from "@/components/dashboard/sandbox/sandbox-data";
import { ImageMark } from "@/components/icons/server-icons";
import {
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	ConfirmDialog,
	EmptyState,
	MoreMenu,
	PageHeader,
	ResourceTable,
	Th,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { serverUrl } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import {
	formatCountdown,
	formatDuration,
	isLive,
	networkLabel,
	sandboxStatus,
	stopsAt,
	useExtendSandbox,
	useMemberNames,
	useNow,
} from "./sandboxes-shared";
import {
	FilterPills,
	FootNote,
	ListSkeleton,
	Meter,
	StatusText,
} from "./server-ui";
import { useServerRef } from "./use-server";

type Filter = "running" | "ended";

export function ServerSandboxesPage() {
	const permissions = usePermissions();
	if (!permissions.sandbox.read) {
		return (
			<EmptyState
				icon={SquareDashedIcon}
				title="Not available"
				description="Your role doesn't include this part of the server."
			/>
		);
	}
	return <SandboxList />;
}

/** `/servers/[id]/sandboxes/new`. */
export function NewSandboxPage() {
	const ref = useServerRef();
	const permissions = usePermissions();
	if (!permissions.sandbox.create) {
		return (
			<EmptyState
				icon={SquareDashedIcon}
				title="Not available"
				description="Your role doesn't include starting sandboxes."
			/>
		);
	}
	return (
		<div className="flex w-full flex-col gap-8 pb-10">
			<PageHeader
				title="New sandbox"
				description="A resource-limited container you can drive from here or through the API. It's removed when its timeout runs out."
			/>
			<NewSandboxForm serverId={ref.serverId} />
		</div>
	);
}

function SandboxList() {
	const ref = useServerRef();
	const permissions = usePermissions();
	const { active } = useOrganization();
	const rows = useQuery(api.live.sandboxes.list, {
		organizationId: active.id,
		serverId: (ref.serverId as Id<"servers"> | undefined) ?? null,
	});
	const sandboxes = rows?.map(toSandbox);
	const running = sandboxes?.filter(isLive) ?? [];
	const ended = sandboxes?.filter((sandbox) => !isLive(sandbox)) ?? [];
	const [filter, setFilter] = useState<Filter>("running");
	const shown = filter === "running" ? running : ended;
	const names = useMemberNames();

	return (
		<div className="flex w-full flex-col gap-6 pb-10">
			<div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2">
				<p className="min-w-0 flex-1 text-muted-foreground text-sm">
					Short-lived, isolated containers for trying an image, running a script
					or giving an agent a shell.
				</p>
				{permissions.sandbox.create ? (
					<AddSandbox serverId={ref.serverId} />
				) : null}
			</div>
			{sandboxes === undefined ? (
				<ListSkeleton rows={3} />
			) : sandboxes.length === 0 ? (
				<EmptyState
					icon={SquareDashedIcon}
					title="No sandboxes yet"
					description="Start one here or through the API. It stops on its own when its timer runs out."
				/>
			) : (
				<>
					<div className="flex flex-wrap items-center gap-2">
						<FilterPills
							value={filter}
							onValueChange={setFilter}
							options={[
								{ value: "running", label: "Running", count: running.length },
								{ value: "ended", label: "Ended", count: ended.length },
							]}
						/>
					</div>
					{shown.length === 0 ? (
						<EmptyState
							icon={SquareDashedIcon}
							title={
								filter === "running" ? "Nothing running" : "No ended sandboxes"
							}
							description={
								filter === "running"
									? "Sandboxes you start show up here while they run."
									: "Sandboxes move here once they stop."
							}
						/>
					) : (
						<ResourceTable
							headers={
								<>
									<Th>Sandbox</Th>
									<Th>Status</Th>
									<Th>Image</Th>
									<Th>CPU / RAM</Th>
									<Th>{filter === "running" ? "Stops in" : "Ran"}</Th>
									<Th className="w-10" />
								</>
							}
						>
							{shown.map((sandbox) => (
								<SandboxRow
									key={sandbox.sandboxId}
									sandbox={sandbox}
									href={serverUrl(
										ref.routeId,
										`sandboxes/${sandbox.sandboxId}`,
									)}
									createdBy={names.get(sandbox.createdBy)}
								/>
							))}
						</ResourceTable>
					)}
				</>
			)}
			<FootNote>
				Up to 50 sandboxes run at once per organization. Each stops after its
				idle timeout, and at most 24 hours after it starts.
			</FootNote>
		</div>
	);
}

function SandboxRow({
	sandbox,
	href,
	createdBy,
}: {
	sandbox: Sandbox;
	href: string;
	createdBy: string | undefined;
}) {
	const permissions = usePermissions();
	const now = useNow();
	const extend = useExtendSandbox();
	const kill = useMutation(api.live.sandboxes.kill);
	const remove = useMutation(api.live.sandboxes.remove);
	const [confirm, setConfirm] = useState<"kill" | "delete" | null>(null);
	const status = sandboxStatus(sandbox);
	const live = isLive(sandbox);
	const left = stopsAt(sandbox) - now;
	const created = new Date(sandbox.createdAt);
	const byline = [
		createdBy ? `by ${createdBy}` : null,
		formatDistanceToNowStrict(created, { addSuffix: true }),
		networkLabel(sandbox),
	]
		.filter(Boolean)
		.join(" · ");
	const ran = sandbox.killedAt
		? formatDuration(sandbox.killedAt - created.getTime())
		: null;

	return (
		<TableRow>
			<TableCell>
				<div className="flex min-w-0 items-center gap-2.5">
					<ImageMark
						image={sandbox.image}
						fallback={SquareDashedIcon}
						muted={!live}
					/>
					<div className="min-w-0">
						<Link href={href} className="font-medium hover:underline">
							{sandbox.name}
						</Link>
						<div className="text-muted-foreground text-xs">{byline}</div>
					</div>
				</div>
			</TableCell>
			<TableCell>
				<StatusText tone={status.tone} label={status.label} />
			</TableCell>
			<TableCell className="font-mono text-[13px] text-muted-foreground">
				{sandbox.image}
			</TableCell>
			<TableCell className="font-mono text-[13px] text-muted-foreground">
				{sandbox.cpu} · {sandbox.memoryMb} MB
			</TableCell>
			<TableCell>
				{live && sandbox.status === "running" ? (
					<div className="flex w-32 flex-col gap-1">
						<span
							className={cn(
								"font-mono text-[13px] tabular-nums",
								left < 5 * 60_000 && "text-warning",
							)}
						>
							{formatCountdown(left)}
						</span>
						<Meter
							percent={(left / sandbox.timeoutMs) * 100}
							tone={left < 5 * 60_000 ? "warning" : undefined}
						/>
					</div>
				) : sandbox.status === "error" ? (
					<span
						className="block max-w-56 truncate text-muted-foreground"
						title={sandbox.error}
					>
						{sandbox.error ?? "—"}
					</span>
				) : (
					<span className="text-muted-foreground">{ran ?? "—"}</span>
				)}
			</TableCell>
			<TableCell>
				<div className="flex justify-end">
					<MoreMenu>
						<DropdownMenuItem
							nativeButton={false}
							render={<Link href={href} />}
						>
							<ArrowUpRightIcon />
							Open
						</DropdownMenuItem>
						{sandbox.status === "running" && permissions.sandbox.create ? (
							<>
								<DropdownMenuItem onClick={() => extend(sandbox)}>
									<TimerResetIcon />
									Extend
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									variant="destructive"
									onClick={() => setConfirm("kill")}
								>
									<OctagonXIcon />
									Kill
								</DropdownMenuItem>
							</>
						) : null}
						{!live && permissions.sandbox.delete ? (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									variant="destructive"
									onClick={() => setConfirm("delete")}
								>
									<Trash2Icon />
									Delete
								</DropdownMenuItem>
							</>
						) : null}
					</MoreMenu>
				</div>
				<ConfirmDialog
					open={confirm !== null}
					onOpenChange={(open) => !open && setConfirm(null)}
					title={
						confirm === "kill"
							? `Kill ${sandbox.name}?`
							: `Delete ${sandbox.name}?`
					}
					description={
						confirm === "kill"
							? "The container stops and is removed. Files inside it are lost."
							: "Removes the sandbox from this list."
					}
					confirmLabel={confirm === "kill" ? "Kill" : "Delete"}
					onConfirm={async () => {
						const sandboxId = sandbox.sandboxId as Id<"sandboxes">;
						try {
							if (confirm === "kill") await kill({ sandboxId });
							else await remove({ sandboxId });
							toast.success(
								confirm === "kill" ? "Sandbox killed" : "Sandbox deleted",
							);
						} catch (error) {
							throw new Error(errorMessage(error));
						}
					}}
				/>
			</TableCell>
		</TableRow>
	);
}
