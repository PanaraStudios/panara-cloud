"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import { formatDistanceToNowStrict } from "date-fns";
import {
	ArrowLeftIcon,
	DownloadIcon,
	OctagonXIcon,
	SquareDashedIcon,
	TimerResetIcon,
	Trash2Icon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ExtendSandboxTimeout } from "@/components/dashboard/sandbox/extend-sandbox-timeout";
import { toSandbox } from "@/components/dashboard/sandbox/sandbox-data";
import { ImageGlyph } from "@/components/icons/server-icons";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
	ConfirmDialog,
	EmptyState,
	MoreMenu,
	StatCell,
	StatStrip,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { useQueryResult } from "@/lib/host-data";
import { usePermissions } from "@/lib/permissions";
import {
	type ConsoleLine,
	consoleText,
	SandboxTerminal,
} from "./sandboxes-console";
import {
	formatCountdown,
	formatDuration,
	isLive,
	sandboxStatus,
	stopsAt,
	useExtendSandbox,
	useMemberNames,
	useNow,
} from "./sandboxes-shared";
import {
	describeFailure,
	FootNote,
	ListSkeleton,
	StatusText,
} from "./server-ui";

const isSandboxId = (value: string) => /^[a-z0-9]{20,64}$/.test(value);

export const SandboxView = ({
	sandboxId,
	listHref,
}: {
	sandboxId: string;
	listHref: string;
}) => {
	const router = useRouter();
	const permissions = usePermissions();
	const result = useQueryResult(
		api.live.sandboxes.get,
		isSandboxId(sandboxId)
			? { sandboxId: sandboxId as Id<"sandboxes"> }
			: "skip",
	);
	const doc = result instanceof Error ? null : result;
	const data = doc ? toSandbox(doc) : undefined;
	const names = useMemberNames();
	const now = useNow();
	const extend = useExtendSandbox();
	const kill = useMutation(api.live.sandboxes.kill);
	const remove = useMutation(api.live.sandboxes.remove);
	const [confirm, setConfirm] = useState<"kill" | "delete" | null>(null);
	const [lines, setLines] = useState<ConsoleLine[]>([]);
	const onLines = useCallback((next: ConsoleLine[]) => setLines(next), []);
	const typedId = sandboxId as Id<"sandboxes">;

	if (result === undefined && isSandboxId(sandboxId)) {
		return <ListSkeleton rows={3} />;
	}
	if (!data) {
		return (
			<EmptyState
				icon={SquareDashedIcon}
				title="Sandbox not found"
				description={
					result instanceof Error
						? errorMessage(result)
						: "It may have been deleted."
				}
			>
				<Button
					variant="outline"
					size="sm"
					nativeButton={false}
					render={<Link href={listHref} />}
				>
					<ArrowLeftIcon />
					All sandboxes
				</Button>
			</EmptyState>
		);
	}

	const status = sandboxStatus(data);
	const running = data.status === "running";
	const canManage = permissions.sandbox.create;
	const created = new Date(data.createdAt);
	const startedBy = names.get(data.createdBy);
	const statusLabel = running
		? `Running · stops in ${formatCountdown(stopsAt(data) - now)}`
		: data.killedAt
			? `${status.label} · ran ${formatDuration(data.killedAt - created.getTime())}`
			: status.label;

	const downloadOutput = () => {
		const blob = new Blob([consoleText(lines)], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = `${data.name}-output.txt`;
		link.click();
		URL.revokeObjectURL(url);
	};

	return (
		<div className="flex h-[calc(100svh-15.5rem)] min-h-[560px] w-full flex-col gap-4">
			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0 space-y-1">
					<Link
						href={listHref}
						className="text-muted-foreground text-small hover:text-foreground"
					>
						Sandboxes
					</Link>
					<div className="flex flex-wrap items-center gap-3">
						<h2 className="flex min-w-0 items-center gap-2 font-semibold text-foreground text-lg">
							<ImageGlyph
								image={data.image}
								fallback={SquareDashedIcon}
								className="size-5"
							/>
							<span className="truncate">{data.name}</span>
						</h2>
						<StatusText
							tone={status.tone}
							label={statusLabel}
							className="tabular-nums"
						/>
					</div>
				</div>
				<div className="flex shrink-0 flex-wrap items-center gap-2">
					{running && canManage ? (
						<>
							<Button variant="outline" onClick={() => extend(data)}>
								<TimerResetIcon data-icon="inline-start" />
								Extend 30 min
							</Button>
							<ExtendSandboxTimeout
								sandboxId={sandboxId}
								currentTimeoutMs={data.timeoutMs}
							/>
							<Button variant="outline" onClick={() => setConfirm("kill")}>
								<OctagonXIcon data-icon="inline-start" />
								Kill
							</Button>
						</>
					) : null}
					{permissions.sandbox.delete && !isLive(data) ? (
						<MoreMenu>
							<DropdownMenuItem
								variant="destructive"
								onClick={() => setConfirm("delete")}
							>
								<Trash2Icon />
								Delete sandbox
							</DropdownMenuItem>
						</MoreMenu>
					) : null}
				</div>
			</div>
			<StatStrip>
				<StatCell label="Image">
					<span className="truncate font-mono text-[13px]">{data.image}</span>
				</StatCell>
				<StatCell label="Resources">
					{data.cpu} CPU · {data.memoryMb} MB
				</StatCell>
				<StatCell label="Runtime">
					<span className="font-mono text-[13px]">
						{data.runtime ?? "runc"}
					</span>
				</StatCell>
				<StatCell label="Network">
					{data.networkMode === "internet" ? "Internet access" : "No internet"}
				</StatCell>
				<StatCell label="Environment">
					{data.hasEnv ? "Variables set" : "No variables"}
				</StatCell>
				<StatCell label="Started">
					<span className="truncate">
						{[
							startedBy,
							formatDistanceToNowStrict(created, { addSuffix: true }),
						]
							.filter(Boolean)
							.join(" · ")}
					</span>
				</StatCell>
			</StatStrip>
			{data.status === "error" && data.error ? (
				<div>
					<p className="text-muted-foreground text-sm">
						{describeFailure(data.error, "this sandbox").sentence.replace(
							"Couldn't load this sandbox.",
							"This sandbox couldn't start.",
						)}
					</p>
					<p className="break-all font-mono text-[12px] text-muted-foreground">
						{data.error}
					</p>
				</div>
			) : null}
			{canManage ? (
				<SandboxTerminal
					sandboxId={sandboxId}
					name={data.name}
					enabled={running}
					workdir={data.workdir}
					user={data.user}
					onLines={onLines}
					className="flex-1"
				/>
			) : (
				<EmptyState
					icon={SquareDashedIcon}
					title="No shell for your role"
					description="Only members who can create sandboxes can run commands in one."
				/>
			)}
			<div className="flex items-center justify-between gap-4">
				<FootNote>
					Commands run with sh -c as {data.user} in {data.workdir}. Everything
					in the sandbox is deleted when it stops.
				</FootNote>
				{canManage ? (
					<Button
						variant="ghost"
						size="sm"
						disabled={lines.length === 0}
						onClick={downloadOutput}
					>
						<DownloadIcon data-icon="inline-start" />
						Download output
					</Button>
				) : null}
			</div>
			<ConfirmDialog
				open={confirm !== null}
				onOpenChange={(open) => !open && setConfirm(null)}
				title={
					confirm === "kill" ? `Kill ${data.name}?` : `Delete ${data.name}?`
				}
				description={
					confirm === "kill"
						? "The container stops and is removed. Files inside it are lost."
						: "Removes the sandbox from the list."
				}
				confirmLabel={confirm === "kill" ? "Kill" : "Delete"}
				onConfirm={async () => {
					if (confirm === "kill") {
						await kill({ sandboxId: typedId });
						toast.success("Sandbox killed");
					} else {
						await remove({ sandboxId: typedId });
						toast.success("Sandbox deleted");
						router.push(listHref);
					}
				}}
			/>
		</div>
	);
};
