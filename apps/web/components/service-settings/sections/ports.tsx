"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import {
	EthernetPortIcon,
	NetworkIcon,
	PencilIcon,
	PlusIcon,
	ServerIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { PROTOCOL_ICONS } from "@/components/icons/service-icons";
import { useService } from "@/components/service/service-context";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	ConfirmDialog,
	EmptyState,
	MoreMenu,
	ResourceTable,
	Th,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { cn } from "@/lib/utils";
import { isRowPending } from "../use-section-pending";
import {
	ChangeTag,
	countLabel,
	DRAFT_ROW,
	Note,
	SectionToolbar,
	UnsavedBar,
} from "./kit";
import type { SectionProps } from "./registry";

type Protocol = "tcp" | "udp";
type Mode = "ingress" | "host";
type Draft = {
	// The port being edited, or null for a new one.
	portId: string | null;
	publishedPort: string;
	targetPort: string;
	protocol: Protocol;
	publishMode: Mode;
};

const EMPTY: Draft = {
	portId: null,
	publishedPort: "",
	targetPort: "",
	protocol: "tcp",
	publishMode: "ingress",
};

function ProtocolIcon({ protocol }: { protocol: Protocol }) {
	const Icon = PROTOCOL_ICONS[protocol];
	return (
		<Icon
			aria-hidden="true"
			className="size-4 shrink-0 text-muted-foreground"
		/>
	);
}

function validPort(value: string) {
	const port = Number(value);
	return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function PortsSection({ id, pending }: SectionProps) {
	const { service } = useService();
	const serverName = service.serverName ?? "the Panara Cloud host";
	const ports = useQuery(api.infra.ports.listByOwner, {
		owner: { kind: "application", id },
	});
	const create = useMutation(api.infra.ports.create);
	const update = useMutation(api.infra.ports.update);
	const remove = useMutation(api.infra.ports.remove);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<string | null>(null);

	const modeLabel = (mode: Mode) =>
		mode === "host"
			? `Host · only on ${serverName}`
			: "Ingress · reachable on every node";

	const clash =
		draft && validPort(draft.publishedPort)
			? ports?.find(
					(port) =>
						port._id !== draft.portId &&
						port.publishedPort === Number(draft.publishedPort) &&
						port.protocol === draft.protocol,
				)
			: undefined;
	const reserved =
		draft && ["80", "443"].includes(draft.publishedPort.trim())
			? draft.publishedPort.trim()
			: null;
	const valid =
		!!draft &&
		validPort(draft.publishedPort) &&
		validPort(draft.targetPort) &&
		!clash &&
		!reserved;

	const save = useCallback(async () => {
		if (!draft || !valid) return;
		setSaving(true);
		setError(null);
		const fields = {
			publishedPort: Number(draft.publishedPort),
			targetPort: Number(draft.targetPort),
			protocol: draft.protocol,
			publishMode: draft.publishMode,
		};
		try {
			if (draft.portId) {
				await update({ portId: draft.portId as Id<"ports">, ...fields });
			} else {
				await create({ owner: { kind: "application", id }, ...fields });
			}
			toast.success(draft.portId ? "Port updated" : "Port added");
			setDraft(null);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setSaving(false);
		}
	}, [draft, valid, update, create, id]);

	if (ports === undefined) return null;

	const startAdd = () => {
		setError(null);
		setDraft({ ...EMPTY });
	};

	const draftRow = draft ? (
		<TableRow key="draft" className={DRAFT_ROW}>
			<TableCell className="py-2">
				<Input
					autoFocus
					inputMode="numeric"
					aria-label="Published port"
					placeholder="e.g. 3478"
					value={draft.publishedPort}
					onChange={(event) => {
						const value = event.target.value;
						setDraft((current) =>
							current
								? {
										...current,
										publishedPort: value,
										// A new port usually maps to the same container port.
										targetPort:
											current.portId === null &&
											current.targetPort === current.publishedPort
												? value
												: current.targetPort,
									}
								: current,
						);
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") void save();
						if (event.key === "Escape") setDraft(null);
					}}
					className="h-8! font-mono text-[13px]"
				/>
			</TableCell>
			<TableCell className="py-2">
				<Input
					inputMode="numeric"
					aria-label="Container port"
					value={draft.targetPort}
					onChange={(event) =>
						setDraft({ ...draft, targetPort: event.target.value })
					}
					onKeyDown={(event) => {
						if (event.key === "Enter") void save();
						if (event.key === "Escape") setDraft(null);
					}}
					className="h-8! font-mono text-[13px]"
				/>
			</TableCell>
			<TableCell className="py-2">
				<Select
					value={draft.protocol}
					onValueChange={(value) =>
						setDraft({ ...draft, protocol: value as Protocol })
					}
				>
					<SelectTrigger aria-label="Protocol" size="sm" className="w-24">
						<SelectValue>{draft.protocol.toUpperCase()}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="tcp">TCP</SelectItem>
						<SelectItem value="udp">UDP</SelectItem>
					</SelectContent>
				</Select>
			</TableCell>
			<TableCell className="py-2">
				<Select
					value={draft.publishMode}
					onValueChange={(value) =>
						setDraft({ ...draft, publishMode: value as Mode })
					}
				>
					<SelectTrigger
						aria-label="Mode"
						size="sm"
						className="w-full min-w-48"
					>
						<SelectValue>{modeLabel(draft.publishMode)}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="ingress">{modeLabel("ingress")}</SelectItem>
						<SelectItem value="host">{modeLabel("host")}</SelectItem>
					</SelectContent>
				</Select>
			</TableCell>
			<TableCell className="py-2">
				<ChangeTag label="Unsaved" />
			</TableCell>
			<TableCell className="py-2 text-right">
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Cancel"
					onClick={() => setDraft(null)}
				>
					<XIcon />
				</Button>
			</TableCell>
		</TableRow>
	) : null;

	const draftPort = draft
		? `${draft.publishedPort || "…"}/${draft.protocol}`
		: "";

	const add = (
		<Button variant="outline" onClick={startAdd} disabled={!!draft}>
			<PlusIcon data-icon="inline-start" />
			Add port
		</Button>
	);

	return (
		<div className="flex flex-col gap-4">
			{ports.length === 0 && !draft ? (
				<EmptyState
					icon={EthernetPortIcon}
					title="No published ports"
					description="Most web services don't need one. Add a port for TCP or UDP services such as databases, game servers or TURN."
				>
					{add}
				</EmptyState>
			) : (
				<>
					<SectionToolbar actions={add}>
						{ports.length > 0
							? countLabel(ports.length, "published port")
							: "New port"}
					</SectionToolbar>
					<ResourceTable
						headers={
							<>
								<Th className="w-44">Published port</Th>
								<Th className="w-44">Container port</Th>
								<Th className="w-32">Protocol</Th>
								<Th>Mode</Th>
								<Th className="w-36">Since last deploy</Th>
								<Th className="w-12" />
							</>
						}
					>
						{ports.map((port) => {
							if (draft?.portId === port._id) return draftRow;
							const changed = isRowPending(pending, {
								port: port.publishedPort,
							});
							return (
								<TableRow key={port._id} className={cn(changed && DRAFT_ROW)}>
									<TableCell className="font-mono text-[13px]">
										{port.publishedPort}
									</TableCell>
									<TableCell className="font-mono text-[13px]">
										{port.targetPort}
									</TableCell>
									<TableCell>
										<span className="flex items-center gap-2 uppercase">
											<ProtocolIcon protocol={port.protocol} />
											{port.protocol}
										</span>
									</TableCell>
									<TableCell className="text-muted-foreground">
										<span className="flex items-center gap-2">
											{port.publishMode === "host" ? (
												<ServerIcon
													aria-hidden="true"
													className="size-4 shrink-0"
												/>
											) : (
												<NetworkIcon
													aria-hidden="true"
													className="size-4 shrink-0"
												/>
											)}
											{modeLabel(port.publishMode)}
										</span>
									</TableCell>
									<TableCell>{changed ? <ChangeTag /> : null}</TableCell>
									<TableCell className="text-right">
										<MoreMenu>
											<DropdownMenuItem
												onClick={() => {
													setError(null);
													setDraft({
														portId: port._id,
														publishedPort: String(port.publishedPort),
														targetPort: String(port.targetPort),
														protocol: port.protocol,
														publishMode: port.publishMode,
													});
												}}
											>
												<PencilIcon className="text-muted-foreground" />
												Edit
											</DropdownMenuItem>
											<DropdownMenuItem
												variant="destructive"
												onClick={() => setDeleting(port._id)}
											>
												<Trash2Icon className="text-muted-foreground" />
												Delete
											</DropdownMenuItem>
										</MoreMenu>
									</TableCell>
								</TableRow>
							);
						})}
						{draft && draft.portId === null ? draftRow : null}
					</ResourceTable>
				</>
			)}
			{draft ? (
				error || clash || reserved ? (
					<Note tone="error">
						{error ??
							(reserved
								? `Port ${reserved} belongs to Traefik on ${serverName}. Use Domains to serve a website.`
								: `Port ${draftPort} is already published by this service.`)}
					</Note>
				) : (
					<Note>
						Port{" "}
						<span className="font-mono text-[13px] text-foreground">
							{draftPort}
						</span>{" "}
						will be published on {serverName}. Panara Cloud checks for clashes
						with other services and Traefik (80, 443) before saving.
					</Note>
				)
			) : null}
			<UnsavedBar
				count={draft ? 1 : 0}
				hint="saving stages it for the next deploy"
				onDiscard={() => setDraft(null)}
				onSave={() => void save()}
				saving={saving}
				disabled={!valid}
			/>
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(open) => {
					if (!open) setDeleting(null);
				}}
				title="Delete port?"
				description="The port stays published until the next deploy."
				onConfirm={async () => {
					if (!deleting) return;
					await remove({ portId: deleting as Id<"ports"> });
					toast.success("Port deleted");
					setDeleting(null);
				}}
			/>
		</div>
	);
}
