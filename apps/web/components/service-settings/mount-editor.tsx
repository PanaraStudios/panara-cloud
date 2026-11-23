"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	type MountInput,
	useMountMutations,
	useServiceMounts,
} from "@/components/dashboard/application/advanced/volumes/use-mounts";
import { MOUNT_ICONS } from "@/components/icons/service-icons";
import { FilterPills } from "@/components/service/filter-pills";
import { useService } from "@/components/service/service-context";
import { FieldGrid } from "@/components/settings/form-kit";
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/auth/errors";
import { serviceSettingsUrl } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { useRouter, useSearchParams } from "@/lib/router";
import Link from "@/lib/router/link";
import { FRAMED_EDITOR, Note, SaveKey, SubPageHeader } from "./sections/kit";
import { lineCount } from "./sections/volumes";
import { useServiceRef } from "./use-service-ref";

type MountType = "volume" | "bind" | "file";

function languageFor(path: string) {
	const name = path.toLowerCase();
	if (name.endsWith(".yml") || name.endsWith(".yaml")) return "yaml";
	if (name.endsWith(".json")) return "json";
	if (name.endsWith(".css")) return "css";
	if (name.endsWith(".sh") || name.endsWith(".bash")) return "shell";
	return "properties";
}

function baseName(path: string) {
	return path.split("/").filter(Boolean).pop() ?? path;
}

/** Add or edit one mount as a page (`settings/volumes/new`,
    `settings/volumes/[mountId]`): type, mount path, and the source — a
    volume name, a host path, or a file written in the editor. */
export function MountEditorPage({ mountId }: { mountId?: string }) {
	const ref = useServiceRef();
	const router = useRouter();
	const params = useSearchParams();
	const { service } = useService();
	const permissions = usePermissions();
	const kind = ref?.kind ?? "application";
	const mounts = useServiceMounts(ref?.id, kind);
	const { create, update } = useMountMutations(kind);
	const existing = mountId
		? mounts?.find((mount) => mount._id === mountId)
		: undefined;

	const initialType = (params.get("type") as MountType | null) ?? "file";
	const [type, setType] = useState<MountType>(
		["volume", "bind", "file"].includes(initialType) ? initialType : "file",
	);
	const [mountPath, setMountPath] = useState("");
	const [source, setSource] = useState("");
	const [filePath, setFilePath] = useState("");
	const [content, setContent] = useState("");
	const [loaded, setLoaded] = useState(!mountId);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!existing || loaded) return;
		setType(existing.type);
		setMountPath(existing.mountPath);
		if (existing.type === "volume") setSource(existing.volumeName);
		if (existing.type === "bind") setSource(existing.hostPath);
		if (existing.type === "file") {
			setFilePath(existing.filePath);
			setContent(existing.content ?? "");
		}
		setLoaded(true);
	}, [existing, loaded]);

	const back = ref ? serviceSettingsUrl(ref, "volumes") : "#";
	const pathOptional = kind === "compose" && type === "file";

	const save = useCallback(async () => {
		setError(null);
		const path = mountPath.trim();
		if (!pathOptional && !path.startsWith("/")) {
			setError("The mount path must be absolute, like /etc/app/config.yml.");
			return;
		}
		let mount: MountInput;
		if (type === "file") {
			const name = filePath.trim() || baseName(path);
			if (!name) {
				setError("Give the file a name.");
				return;
			}
			mount = { type: "file", filePath: name, content, mountPath: path };
		} else if (type === "volume") {
			if (!source.trim()) return setError("Name the volume.");
			mount = { type: "volume", volumeName: source.trim(), mountPath: path };
		} else {
			if (!source.trim().startsWith("/"))
				return setError("The host path must be absolute.");
			mount = { type: "bind", hostPath: source.trim(), mountPath: path };
		}
		if (!ref) return;
		setSaving(true);
		try {
			if (mountId) await update(mountId, mount);
			else await create(ref.id, mount);
			toast.success(mountId ? "Mount saved" : "Mount added");
			router.push(back);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setSaving(false);
		}
	}, [
		mountPath,
		pathOptional,
		type,
		filePath,
		content,
		source,
		ref,
		mountId,
		update,
		create,
		router,
		back,
	]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key === "s") {
				event.preventDefault();
				if (!saving) void save();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [save, saving]);

	if (!ref || !permissions.volume.create) return null;
	if (mountId && mounts !== undefined && !existing) {
		return (
			<p className="text-muted-foreground text-sm">
				This mount no longer exists.{" "}
				<Link href={back} className="text-foreground underline">
					Back to Volumes
				</Link>
			</p>
		);
	}
	if (!loaded) return null;

	const name =
		type === "file"
			? filePath || baseName(mountPath) || "new file"
			: type === "volume"
				? source || "new volume"
				: source || "new bind";

	return (
		<div className="flex w-full flex-col gap-6 pb-16">
			<SubPageHeader
				back={back}
				list="Volumes"
				title={`${mountId ? "Edit mount" : "Add mount"} · ${name}`}
			/>
			<FieldGrid>
				<div className="flex flex-col gap-3">
					<Label>Type</Label>
					<FilterPills
						aria-label="Mount type"
						value={type}
						onValueChange={setType}
						className="h-control w-fit"
						items={[
							{
								value: "volume" as const,
								label: "Volume",
								icon: <MOUNT_ICONS.volume aria-hidden="true" />,
							},
							{
								value: "bind" as const,
								label: "Bind",
								icon: <MOUNT_ICONS.bind aria-hidden="true" />,
							},
							{
								value: "file" as const,
								label: "File",
								icon: <MOUNT_ICONS.file aria-hidden="true" />,
							},
						]}
					/>
				</div>
				<div className="flex flex-col gap-3">
					<Label htmlFor="mount-path">
						Mount path in container
						{pathOptional ? (
							<span className="font-normal text-muted-foreground">
								{" "}
								(optional for Compose)
							</span>
						) : null}
					</Label>
					<Input
						id="mount-path"
						className="font-mono"
						placeholder={
							type === "file" ? "/etc/nginx/conf.d/default.conf" : "/app/data"
						}
						value={mountPath}
						onChange={(event) => setMountPath(event.target.value)}
					/>
				</div>
				{type === "file" ? null : (
					<div className="flex flex-col gap-3">
						<Label htmlFor="mount-source">
							{type === "volume" ? "Volume name" : "Host path"}
						</Label>
						<Input
							id="mount-source"
							className="font-mono"
							placeholder={
								type === "volume" ? `${service.appName}-data` : "/srv/data"
							}
							value={source}
							onChange={(event) => setSource(event.target.value)}
						/>
						<p className="text-muted-foreground text-sm">
							{type === "volume"
								? "A Docker volume on the server. It survives deploys and is kept when the mount is removed."
								: `A directory on ${service.serverName ?? "the server"}, mounted as is.`}
						</p>
					</div>
				)}
			</FieldGrid>
			{type === "file" ? (
				<div className="overflow-hidden rounded-xl border border-border bg-background">
					<div className="flex h-11 items-center justify-between gap-4 border-border border-b px-4">
						<input
							aria-label="File name"
							placeholder={baseName(mountPath) || "file name"}
							value={filePath}
							onChange={(event) => setFilePath(event.target.value)}
							className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground"
						/>
						<span className="shrink-0 text-muted-foreground text-xs">
							{lineCount(content)} lines · stored in ../files/
							{filePath || baseName(mountPath) || "…"}
						</span>
					</div>
					<CodeEditor
						language={languageFor(filePath || mountPath)}
						value={content}
						onChange={setContent}
						placeholder="File contents"
						wrapperClassName="min-h-80 max-h-[60vh]"
						className={FRAMED_EDITOR}
					/>
				</div>
			) : null}
			{error ? <Note tone="error">{error}</Note> : null}
			<div className="flex flex-col gap-3 border-border border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
				<p className="text-muted-foreground text-sm">
					Saving stages the change; {service.name} picks it up on the next
					deploy{type === "file" ? " (a restart is enough)" : ""}.
				</p>
				<div className="flex items-center gap-2">
					<Button
						variant="ghost"
						nativeButton={false}
						render={<Link href={back} />}
					>
						Cancel
					</Button>
					<Button onClick={() => void save()} isLoading={saving}>
						Save
						<SaveKey />
					</Button>
				</div>
			</div>
		</div>
	);
}
