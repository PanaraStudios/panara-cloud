"use client";

import { api } from "@panara-cloud/backend/api";
import { useConvex, useMutation } from "convex/react";
import {
	BoxIcon,
	BracesIcon,
	InfoIcon,
	LayersIcon,
	SlidersHorizontalIcon,
	Trash2Icon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
	formatDockerSize,
	toServerId,
} from "@/components/dashboard/docker/format";
import { ImageGlyph } from "@/components/icons/server-icons";
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Section } from "@/components/ui-kit/primitives";
import { useDockerInspectQuery, waitForJob } from "@/lib/host-data";
import { serverUrl } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { containerStatus } from "./containers-data";
import { containerHref } from "./containers-list";
import { splitReference, useServerImages } from "./images-data";
import { shortAgo } from "./images-list";
import {
	DetailRows,
	FootNote,
	ListSkeleton,
	LoadFailed,
	SectionRow,
	StatusText,
} from "./server-ui";
import { useServerRef } from "./use-server";

type ImageInspect = {
	Id?: string;
	RepoTags?: string[] | null;
	RepoDigests?: string[] | null;
	Created?: string;
	Size?: number;
	Architecture?: string;
	Os?: string;
	Variant?: string;
	Config?: {
		Entrypoint?: string[] | null;
		Cmd?: string[] | null;
		ExposedPorts?: Record<string, unknown> | null;
		WorkingDir?: string;
		User?: string;
		Env?: string[] | null;
	};
	RootFS?: { Layers?: string[] };
};

const FORCE_HINT =
	/must be forced|image is being used|referenced in multiple repositories/i;

const mono = (value: React.ReactNode) => (
	<span className="font-mono text-[13px]">{value}</span>
);

const none = <span className="text-muted-foreground">—</span>;

const shortDigest = (id: string) => {
	const hex = id.replace(/^sha256:/, "");
	return `sha256:${hex.slice(0, 16)}…${hex.slice(-4)}`;
};

export function ImageInspectPage({ imageId }: { imageId: string }) {
	const ref = useServerRef();
	const router = useRouter();
	const permissions = usePermissions();
	const convex = useConvex();
	const run = useMutation(api.infra.docker.run);
	const { rows } = useServerImages(ref.serverId);
	const image = rows?.find((row) => row.id === imageId);
	const { data, isLoading, error } = useDockerInspectQuery<ImageInspect>(
		ref.serverId,
		{ type: "imageInspect", imageRef: imageId },
	);
	const [raw, setRaw] = useState(false);
	const [confirm, setConfirm] = useState<"remove" | "force" | null>(null);
	const [forceReason, setForceReason] = useState("");

	const tags =
		data?.RepoTags?.filter((tag) => tag !== "<none>:<none>") ??
		image?.tags ??
		[];
	const primary = tags[0] ? splitReference(tags[0]) : null;
	const name = primary
		? (primary.repository.split("/").pop() ?? primary.repository)
		: imageId.replace(/^sha256:/, "").slice(0, 12);
	const usedBy = image?.usedBy ?? [];
	const inUse = image?.inUse ?? false;
	const created = data?.Created ? new Date(data.Created) : image?.created;
	const layers = data?.RootFS?.Layers?.length;
	const env = data?.Config?.Env ?? [];
	const ports = Object.keys(data?.Config?.ExposedPorts ?? {});

	const remove = async (force: boolean) => {
		try {
			const jobId = await run({
				serverId: toServerId(ref.serverId),
				action: { type: "imageRemove", imageRef: tags[0] ?? imageId, force },
			});
			await waitForJob(convex, jobId);
			toast.success("Image removed");
			router.push(serverUrl(ref.routeId, "images"));
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			if (!force && FORCE_HINT.test(message)) {
				setForceReason(message);
				setConfirm("force");
				return;
			}
			throw cause;
		}
	};

	return (
		<div className="flex w-full flex-col gap-6 pb-10">
			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0 space-y-1">
					<p className="text-muted-foreground text-small">
						<Link
							href={serverUrl(ref.routeId, "images")}
							className="hover:text-foreground"
						>
							Images
						</Link>
					</p>
					<h2 className="flex min-w-0 items-center gap-2 font-semibold text-foreground text-lg">
						<ImageGlyph
							image={tags[0]}
							fallback={LayersIcon}
							className="size-5"
						/>
						<span className="truncate">
							{name}
							{primary?.tag ? (
								<span className="text-muted-foreground">:{primary.tag}</span>
							) : null}
						</span>
					</h2>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<Button
						variant="outline"
						disabled={!data}
						onClick={() => setRaw(!raw)}
					>
						<BracesIcon data-icon="inline-start" />
						{raw ? "Hide raw JSON" : "Raw JSON"}
					</Button>
					{permissions.docker.read ? (
						<Button
							variant="outline"
							disabled={inUse}
							onClick={() => setConfirm("remove")}
						>
							<Trash2Icon data-icon="inline-start" />
							Remove
						</Button>
					) : null}
				</div>
			</div>
			{raw && data ? (
				<div className="overflow-hidden rounded-xl border border-border">
					<CodeEditor
						language="json"
						lineWrapping
						readOnly
						value={JSON.stringify(data, null, 2)}
					/>
				</div>
			) : null}
			{isLoading && !data ? (
				<ListSkeleton />
			) : error && !data ? (
				<LoadFailed icon={LayersIcon} what="this image" error={error} />
			) : (
				<div className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
					<div className="flex min-w-0 flex-col gap-8">
						<Section title="Details" icon={InfoIcon}>
							<DetailRows
								labelWidth="w-40"
								rows={[
									{
										label: "Image ID",
										value: mono(shortDigest(data?.Id ?? imageId)),
									},
									{
										label: "Repository",
										value: primary ? mono(primary.repository) : none,
									},
									{
										label: "Tags",
										value: tags.length
											? mono(
													tags
														.map((tag) => splitReference(tag).tag ?? tag)
														.join(" · "),
												)
											: none,
									},
									{
										label: "Size",
										value: (
											<>
												{formatDockerSize(data?.Size ?? image?.size)}
												{layers ? (
													<span className="text-muted-foreground">
														{" · "}
														{layers} layers
													</span>
												) : null}
											</>
										),
									},
									{
										label: "Created",
										value: created ? (
											<>
												{created.toLocaleString(undefined, {
													day: "numeric",
													month: "short",
													year: "numeric",
													hour: "2-digit",
													minute: "2-digit",
												})}
												<span className="text-muted-foreground">
													{" · "}
													{shortAgo(created)}
												</span>
											</>
										) : (
											none
										),
									},
									{
										label: "Platform",
										value: data?.Os
											? mono(
													[data.Os, data.Architecture, data.Variant]
														.filter(Boolean)
														.join("/"),
												)
											: none,
									},
								]}
							/>
						</Section>
						<Section title="Config" icon={SlidersHorizontalIcon}>
							<DetailRows
								labelWidth="w-40"
								rows={[
									{
										label: "Entrypoint",
										value: data?.Config?.Entrypoint?.length
											? mono(JSON.stringify(data.Config.Entrypoint))
											: none,
									},
									{
										label: "Command",
										value: data?.Config?.Cmd?.length
											? mono(JSON.stringify(data.Config.Cmd))
											: none,
									},
									{
										label: "Exposed ports",
										value: ports.length ? mono(ports.join(", ")) : none,
									},
									{
										label: "Working dir",
										value: data?.Config?.WorkingDir
											? mono(data.Config.WorkingDir)
											: none,
									},
									{
										label: "User",
										value: data?.Config?.User ? mono(data.Config.User) : none,
									},
									{
										label: "Environment",
										value: env.length ? (
											<div className="flex flex-col font-mono text-[13px] leading-6">
												{env.map((line) => (
													<span key={line} className="break-all">
														{line}
													</span>
												))}
											</div>
										) : (
											none
										),
									},
								]}
							/>
						</Section>
					</div>
					<Section
						title="Used by"
						icon={BoxIcon}
						hint={`${usedBy.length} container${usedBy.length === 1 ? "" : "s"}`}
					>
						{usedBy.map((container) => {
							const status = containerStatus(container);
							return (
								<SectionRow
									key={container.containerId}
									label={
										<Link
											href={containerHref(ref.routeId, container.containerId)}
											className="flex min-w-0 items-center gap-2 hover:underline"
										>
											<StatusText tone={status.tone} label="" />
											<span className="truncate font-mono text-[13px]">
												{container.name}
											</span>
										</Link>
									}
								>
									{container.system ? "System" : (container.owner?.label ?? "")}
								</SectionRow>
							);
						})}
						<FootNote className="pt-3">
							{inUse
								? "Remove is off while a container uses this image."
								: "No container uses this image; removing it frees the space."}
						</FootNote>
					</Section>
				</div>
			)}
			<ConfirmDialog
				open={confirm === "remove"}
				onOpenChange={(open) =>
					!open &&
					setConfirm((current) => (current === "remove" ? null : current))
				}
				title="Remove image?"
				description={`${tags[0] ?? shortDigest(imageId)} is removed from ${ref.name ?? "this server"}. It's pulled again by the next deploy that needs it.`}
				confirmLabel="Remove"
				onConfirm={() => remove(false)}
			/>
			<ConfirmDialog
				open={confirm === "force"}
				onOpenChange={(open) => !open && setConfirm(null)}
				title="Force removal?"
				description={`${forceReason} Forcing it may affect containers that still reference this image.`}
				confirmLabel="Force remove"
				onConfirm={() => remove(true)}
			/>
		</div>
	);
}
