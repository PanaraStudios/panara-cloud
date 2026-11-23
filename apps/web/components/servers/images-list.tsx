"use client";

import { api } from "@panara-cloud/backend/api";
import { useConvex, useMutation } from "convex/react";
import { LayersIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
	formatDockerSize,
	toServerId,
} from "@/components/dashboard/docker/format";
import { ImageMark } from "@/components/icons/server-icons";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	ConfirmDialog,
	EmptyState,
	ResourceTable,
	Th,
	useDebouncedValue,
} from "@/components/ui-kit/primitives";
import { cleanupAction } from "@/lib/docker-cleanup";
import { waitForJob } from "@/lib/host-data";
import { serverUrl } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { cn } from "@/lib/utils";
import {
	type ImageRow,
	shortImageId,
	splitReference,
	useServerImages,
} from "./images-data";
import {
	FilterPills,
	ListSkeleton,
	LoadFailed,
	SearchField,
} from "./server-ui";
import { useServerRef } from "./use-server";

type Filter = "all" | "inUse" | "unused";

export const imageHref = (routeId: string, imageId: string) =>
	`${serverUrl(routeId, "images")}/${encodeURIComponent(imageId)}`;

// "2 h ago", "3 d ago", "2 wk ago".
export function shortAgo(date: Date) {
	const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
	const steps: [number, string][] = [
		[31_536_000, "y"],
		[2_592_000, "mo"],
		[604_800, "wk"],
		[86_400, "d"],
		[3_600, "h"],
		[60, "min"],
	];
	for (const [size, unit] of steps) {
		if (seconds >= size) return `${Math.floor(seconds / size)} ${unit} ago`;
	}
	return "just now";
}

export function ImageName({
	reference,
	muted,
}: {
	reference: string | undefined;
	muted?: boolean;
}) {
	if (!reference) {
		return (
			<span className="font-mono text-[13px] text-muted-foreground">
				&lt;none&gt;:&lt;none&gt;
			</span>
		);
	}
	const { repository, tag } = splitReference(reference);
	return (
		<span
			className={cn("font-mono text-[13px]", muted && "text-muted-foreground")}
		>
			{repository}
			{tag ? <span className="text-muted-foreground">:{tag}</span> : null}
		</span>
	);
}

export function UsedBy({ image }: { image: ImageRow }) {
	const first = image.usedBy[0];
	if (!first) {
		return (
			<span className="text-muted-foreground">
				{image.inUse
					? "In use"
					: image.tags.length === 0
						? "Dangling"
						: "Unused"}
			</span>
		);
	}
	if (image.system)
		return <span className="text-muted-foreground">System</span>;
	const owners = Array.from(
		new Set(
			image.usedBy.map((container) => container.owner?.label ?? container.name),
		),
	);
	return (
		<span>
			{first.owner?.href ? (
				<Link href={first.owner.href} className="hover:underline">
					{owners[0]}
				</Link>
			) : (
				owners[0]
			)}
			{owners.length > 1 ? (
				<span className="text-muted-foreground"> +{owners.length - 1}</span>
			) : null}
		</span>
	);
}

export function ServerImagesList() {
	const ref = useServerRef();
	const { active } = useOrganization();
	const isAdmin = active.role === "owner" || active.role === "admin";
	const convex = useConvex();
	const cleanup = useMutation(api.infra.docker.cleanup);
	const { rows, isLoading, error, refresh, isRefreshing } = useServerImages(
		ref.serverId,
	);
	const [query, setQuery] = useState("");
	const search = useDebouncedValue(query).trim().toLowerCase();
	const [filter, setFilter] = useState<Filter>("all");
	const [pruneOpen, setPruneOpen] = useState(false);

	const totals = useMemo(() => {
		const all = rows ?? [];
		return {
			all: all.length,
			inUse: all.filter((image) => image.inUse).length,
			unused: all.filter((image) => !image.inUse).length,
			size: all.reduce((sum, image) => sum + image.size, 0),
			reclaimable: all
				.filter((image) => !image.inUse)
				.reduce((sum, image) => sum + image.size, 0),
		};
	}, [rows]);

	const visible = useMemo(
		() =>
			(rows ?? [])
				.filter((image) =>
					filter === "inUse"
						? image.inUse
						: filter === "unused"
							? !image.inUse
							: true,
				)
				.filter(
					(image) =>
						!search ||
						image.id.toLowerCase().includes(search) ||
						image.tags.some((tag) => tag.toLowerCase().includes(search)),
				)
				.sort(
					(a, b) =>
						Number(b.inUse && !b.system) - Number(a.inUse && !a.system) ||
						Number(a.system) - Number(b.system) ||
						b.created.getTime() - a.created.getTime(),
				),
		[rows, filter, search],
	);

	return (
		<div className="flex w-full flex-col gap-6 pb-10">
			{error && !rows ? null : (
				<div className="flex flex-wrap items-center gap-2">
					<SearchField
						value={query}
						onChange={setQuery}
						placeholder="Search repository, tag or ID…"
					/>
					<FilterPills
						value={filter}
						onValueChange={setFilter}
						options={[
							{ value: "all", label: "All", count: totals.all },
							{ value: "inUse", label: "In use", count: totals.inUse },
							{ value: "unused", label: "Unused", count: totals.unused },
						]}
					/>
					<div className="ml-auto flex items-center gap-3">
						{rows ? (
							<p className="text-muted-foreground text-sm">
								{formatDockerSize(totals.size)} on disk
								{totals.reclaimable > 0 ? (
									<>
										{" · "}
										<span className="text-foreground">
											{formatDockerSize(totals.reclaimable)} reclaimable
										</span>
									</>
								) : null}
							</p>
						) : null}
						{isAdmin ? (
							<Button
								variant="outline"
								onClick={() => setPruneOpen(true)}
								disabled={totals.unused === 0}
							>
								Prune unused…
							</Button>
						) : null}
					</div>
				</div>
			)}
			{isLoading ? (
				<ListSkeleton />
			) : error && !rows ? (
				<LoadFailed
					icon={LayersIcon}
					what="images"
					error={error}
					onRetry={() => void refresh()}
					retrying={isRefreshing}
				/>
			) : visible.length === 0 ? (
				<EmptyState
					icon={LayersIcon}
					title={totals.all === 0 ? "No images" : "No matches"}
					description={
						totals.all === 0
							? "Images pulled or built on this server show up here."
							: "No image matches the search or filter."
					}
				/>
			) : (
				<ResourceTable
					headers={
						<>
							<Th className="w-1/3">Image</Th>
							<Th>ID</Th>
							<Th>Size</Th>
							<Th>Created</Th>
							<Th className="w-1/4">Used by</Th>
							<Th className="w-24" />
						</>
					}
				>
					{visible.map((image) => {
						const href = imageHref(ref.routeId, image.id);
						return (
							<TableRow key={image.id}>
								<TableCell className="max-w-0">
									<div className="flex min-w-0 items-center gap-2.5">
										<ImageMark
											image={image.tags[0]}
											fallback={LayersIcon}
											system={image.system}
											muted={image.system}
										/>
										<div className="min-w-0 truncate">
											<Link href={href} className="font-medium hover:underline">
												<ImageName
													reference={image.tags[0]}
													muted={image.system}
												/>
											</Link>
											{image.tags.length > 1 ? (
												<span className="ml-1.5 text-muted-foreground text-xs">
													+{image.tags.length - 1} tags
												</span>
											) : null}
										</div>
									</div>
								</TableCell>
								<TableCell className="font-mono text-[13px] text-muted-foreground">
									{shortImageId(image.id)}
								</TableCell>
								<TableCell className="font-mono text-[13px] text-muted-foreground">
									{formatDockerSize(image.size)}
								</TableCell>
								<TableCell className="text-muted-foreground">
									{shortAgo(image.created)}
								</TableCell>
								<TableCell className="max-w-0 truncate">
									<UsedBy image={image} />
								</TableCell>
								<TableCell className="text-right">
									<Button
										variant="outline"
										size="sm"
										nativeButton={false}
										render={<Link href={href} />}
									>
										Inspect
									</Button>
								</TableCell>
							</TableRow>
						);
					})}
				</ResourceTable>
			)}
			<ConfirmDialog
				open={pruneOpen}
				onOpenChange={setPruneOpen}
				title={cleanupAction("images").title}
				description={`${cleanupAction("images").description} About ${formatDockerSize(totals.reclaimable)} can be freed.`}
				confirmLabel={cleanupAction("images").confirmLabel}
				onConfirm={async () => {
					const jobId = await cleanup({
						serverId: toServerId(ref.serverId),
						scope: "images",
					});
					await waitForJob(convex, jobId);
					toast.success("Unused images removed");
				}}
			/>
		</div>
	);
}
