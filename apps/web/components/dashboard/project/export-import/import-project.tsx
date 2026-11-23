"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useServerNames } from "@/components/servers/use-server-states";
import { ServiceIcon } from "@/components/service/service-icon";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { errorMessage } from "@/lib/auth/errors";
import { isServiceKind, SERVICE_KIND_LABELS } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import {
	AutofillDecoy,
	MIN_PASSPHRASE_LENGTH,
	PassphraseField,
} from "./passphrase-fields";

type Preview = FunctionReturnType<
	typeof api.platform.projectTransferNode.previewImport
>;

const LOCAL_SERVER = "local";

export const ImportProject = ({
	label = "Import project",
	icon = true,
	openSignal = 0,
}: {
	label?: string;
	icon?: boolean;
	/** Bumping it opens the dialog from elsewhere (the new project dialog). */
	openSignal?: number;
} = {}) => {
	const { active } = useOrganization();
	const [open, setOpen] = useState(false);
	const [bundle, setBundle] = useState<File | null>(null);
	const [storageId, setStorageId] = useState<Id<"_storage"> | null>(null);
	const [passphrase, setPassphrase] = useState("");
	const [preview, setPreview] = useState<Preview | null>(null);
	const [serverId, setServerId] = useState("");
	const servers = useServerNames(open)?.filter(
		(server) => server.state !== "notSetUp" && server.serverType !== "build",
	);
	const showLocalOption = !useQuery(
		api.platform.deployTargets.remoteServersOnly,
		open ? {} : "skip",
	);
	const selectedServer =
		!showLocalOption && serverId === LOCAL_SERVER ? "" : serverId;
	const generateUploadUrl = useMutation(
		api.platform.projectTransfer.generateImportUploadUrl,
	);
	const previewImport = useAction(
		api.platform.projectTransferNode.previewImport,
	);
	const importProject = useAction(
		api.platform.projectTransferNode.importProject,
	);
	const [isPreviewing, setIsPreviewing] = useState(false);
	const [isImporting, setIsImporting] = useState(false);

	const reset = () => {
		setBundle(null);
		setStorageId(null);
		setPassphrase("");
		setPreview(null);
		setServerId(LOCAL_SERVER);
	};

	const handleOpenChange = (next: boolean) => {
		if (isImporting) return;
		setOpen(next);
		if (next) reset();
	};

	useEffect(() => {
		if (openSignal > 0) handleOpenChange(true);
		// biome-ignore lint/correctness/useExhaustiveDependencies: only a new signal opens it
	}, [openSignal]);

	const handleFile = (file: File | undefined) => {
		setPreview(null);
		setStorageId(null);
		setBundle(file ?? null);
	};

	const upload = async (file: File) => {
		if (storageId) return storageId;
		const url = await generateUploadUrl({ organizationId: active.id });
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": file.type || "application/json" },
			body: file,
		});
		if (!response.ok) throw new Error("Upload failed");
		const { storageId: uploaded } = (await response.json()) as {
			storageId: Id<"_storage">;
		};
		setStorageId(uploaded);
		return uploaded;
	};

	const handlePreview = async () => {
		if (!bundle) return;
		setIsPreviewing(true);
		try {
			const result = await previewImport({
				organizationId: active.id,
				storageId: await upload(bundle),
				passphrase: passphrase || undefined,
			});
			setPreview(result);
		} catch (error) {
			toast.error(errorMessage(error) || "Invalid bundle");
		} finally {
			setIsPreviewing(false);
		}
	};

	const handleImport = async () => {
		if (!bundle || !storageId || !preview) return;
		setIsImporting(true);
		try {
			const result = await importProject({
				organizationId: active.id,
				storageId,
				passphrase: passphrase || undefined,
				serverId:
					!selectedServer || selectedServer === LOCAL_SERVER
						? undefined
						: (selectedServer as Id<"servers">),
			});
			toast.success(`Imported as "${preview.projectName}"`);
			setOpen(false);
			for (const warning of result.warnings) toast.warning(warning);
		} catch (error) {
			toast.error(errorMessage(error) || "Import failed");
		} finally {
			setIsImporting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger render={<Button variant="outline" />}>
				{icon ? <Upload data-icon="inline-start" /> : null}
				{label}
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-2xl max-h-[85vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Import project</DialogTitle>
					<DialogDescription>
						Create a new project from a project export file. Services are
						created but not deployed.
					</DialogDescription>
				</DialogHeader>

				{!preview ? (
					<div className="space-y-4">
						<div className="grid gap-2">
							<Label htmlFor="bundle-file">Export file</Label>
							<Input
								id="bundle-file"
								type="file"
								onChange={(e) => handleFile(e.target.files?.[0])}
							/>
						</div>
						<AutofillDecoy />
						<PassphraseField
							id="import-passphrase"
							label="Passphrase"
							value={passphrase}
							onChange={setPassphrase}
						/>
					</div>
				) : (
					<div className="space-y-4">
						<div className="grid gap-2">
							<Label>Server</Label>
							<Select
								names="server"
								value={selectedServer}
								onValueChange={setServerId}
							>
								<SelectTrigger className="w-full">
									<SelectValue placeholder="Select the server for the services" />
								</SelectTrigger>
								<SelectContent>
									{showLocalOption && (
										<SelectItem value={LOCAL_SERVER}>
											Panara Cloud server
										</SelectItem>
									)}
									{servers?.map((server) => (
										<SelectItem key={server._id} value={server._id}>
											{server.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-2 rounded-md border p-3 text-sm">
							{preview.environments.map((env) => (
								<div key={env.name}>
									<p className="font-medium">{env.name}</p>
									<ul className="mt-1 flex flex-col gap-1 text-muted-foreground">
										{env.services.map((service) => (
											<li
												key={`${service.type}-${service.name}`}
												className="flex items-center gap-2"
											>
												{isServiceKind(service.type) ? (
													<ServiceIcon kind={service.type} />
												) : null}
												<span className="min-w-0 truncate">{service.name}</span>
												<span className="text-xs">
													{isServiceKind(service.type)
														? SERVICE_KIND_LABELS[service.type]
														: service.type}
												</span>
											</li>
										))}
									</ul>
								</div>
							))}
						</div>
						{preview.warnings.length > 0 && (
							<AlertBlock type="warning">
								<ul className="list-disc space-y-1 pl-4">
									{preview.warnings.map((warning) => (
										<li key={warning}>{warning}</li>
									))}
								</ul>
							</AlertBlock>
						)}
					</div>
				)}

				<DialogFooter>
					{!preview ? (
						<Button
							isLoading={isPreviewing}
							disabled={!bundle || passphrase.length < MIN_PASSPHRASE_LENGTH}
							onClick={handlePreview}
						>
							Continue
						</Button>
					) : (
						<>
							<Button
								variant="outline"
								disabled={isImporting}
								onClick={() => setPreview(null)}
							>
								Back
							</Button>
							<Button
								isLoading={isImporting}
								disabled={!selectedServer}
								onClick={handleImport}
							>
								Import
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
