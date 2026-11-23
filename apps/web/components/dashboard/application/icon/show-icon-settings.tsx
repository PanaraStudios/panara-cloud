"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import { CircuitBoard, GlobeIcon, Pencil, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Dropzone } from "@/components/ui/dropzone";
import { Input } from "@/components/ui/input";
import { type BundledIcon, bundledIcons } from "@/lib/bundled-icons";
import { resizeImage } from "@/utils/image-processing";
import { sanitizeSvg } from "@/utils/sanitize-svg";

interface ShowIconSettingsProps {
	serviceId: string;
	serviceType: "application" | "compose";
	icon?: string | null;
}

const svgToDataUrl = (icon: BundledIcon): string => {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#${icon.hex}"><path d="${icon.path}"/></svg>`;
	return `data:image/svg+xml;base64,${btoa(svg)}`;
};

export const ShowIconSettings = ({
	serviceId,
	serviceType,
	icon,
}: ShowIconSettingsProps) => {
	const [open, setOpen] = useState(false);
	const [iconSearchQuery, setIconSearchQuery] = useState("");
	const [iconsToShow, setIconsToShow] = useState(24);

	const filteredIcons = useMemo(() => {
		if (!iconSearchQuery) return bundledIcons;
		const q = iconSearchQuery.toLowerCase();
		return bundledIcons.filter(
			(i) =>
				i.title.toLowerCase().includes(q) || i.slug.toLowerCase().includes(q),
		);
	}, [iconSearchQuery]);

	const displayedIcons = filteredIcons.slice(0, iconsToShow);
	const hasMoreIcons = filteredIcons.length > iconsToShow;

	const updateApplication = useMutation(api.applications.applications.update);
	const updateCompose = useMutation(api.compose.crud.update);

	const updateIcon = async (newIcon: string | null) => {
		if (serviceType === "compose") {
			await updateCompose({
				composeId: serviceId as Id<"compose">,
				icon: newIcon,
			});
			return;
		}
		await updateApplication({
			applicationId: serviceId as Id<"applications">,
			icon: newIcon,
		});
	};

	useEffect(() => {
		if (open) {
			setIconSearchQuery("");
			setIconsToShow(24);
		}
	}, [open]);

	const handleIconSelect = async (selectedIcon: BundledIcon) => {
		try {
			const dataUrl = svgToDataUrl(selectedIcon);
			await updateIcon(dataUrl);
			toast.success("Icon saved successfully");
			setOpen(false);
		} catch (_error) {
			toast.error("Error saving icon");
		}
	};

	const handleRemoveIcon = async () => {
		try {
			await updateIcon(null);
			toast.success("Icon removed");
		} catch (_error) {
			toast.error("Error removing icon");
		}
	};

	const handleFileUpload = async (files: FileList | null) => {
		if (!files || files.length === 0) return;
		const file = files[0];
		if (!file) return;

		const allowedTypes = [
			"image/jpeg",
			"image/jpg",
			"image/png",
			"image/svg+xml",
		];
		const fileExtension = file.name.split(".").pop()?.toLowerCase();
		const allowedExtensions = ["jpg", "jpeg", "png", "svg"];

		if (
			!allowedTypes.includes(file.type) &&
			!allowedExtensions.includes(fileExtension || "")
		) {
			toast.error("Only JPG, JPEG, PNG, and SVG files are allowed");
			return;
		}

		if (file.size > 2 * 1024 * 1024) {
			toast.error("Image size must be less than 2MB");
			return;
		}

		const isSvg = file.type === "image/svg+xml" || fileExtension === "svg";

		if (isSvg) {
			const text = await file.text();
			const sanitizedDataUrl = sanitizeSvg(text);
			if (!sanitizedDataUrl) {
				toast.error("Invalid SVG file");
				return;
			}
			try {
				await updateIcon(sanitizedDataUrl);
				toast.success("Icon saved!");
				setOpen(false);
			} catch (_error) {
				toast.error("Error saving icon");
			}
			return;
		}

		try {
			await updateIcon(await resizeImage(file, 256));
			toast.success("Icon saved!");
			setOpen(false);
		} catch (_error) {
			toast.error("Error saving icon");
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				render={
					<button
						type="button"
						className="relative group flex items-center justify-center"
					/>
				}
			>
				{icon ? (
					<img
						src={icon}
						alt="Service icon"
						className="h-8 w-8 object-contain"
					/>
				) : serviceType === "compose" ? (
					<CircuitBoard className="h-6 w-6 text-muted-foreground" />
				) : (
					<GlobeIcon className="h-6 w-6 text-muted-foreground" />
				)}
				<div className="absolute inset-0 flex items-center justify-center rounded bg-foreground/60 opacity-0 transition-opacity group-hover:opacity-100">
					<Pencil className="size-3 text-background" />
				</div>
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle className="flex items-center justify-between">
						Change icon
						{icon && (
							<Button
								variant="ghost"
								size="sm"
								onClick={handleRemoveIcon}
								className="text-muted-foreground"
							>
								<X data-icon="inline-start" />
								Remove icon
							</Button>
						)}
					</DialogTitle>
				</DialogHeader>

				<div className="space-y-4">
					<div className="relative">
						<Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
						<Input
							placeholder="Search icons, e.g. react, docker"
							value={iconSearchQuery}
							onChange={(e) => setIconSearchQuery(e.target.value)}
							className="pl-9"
						/>
					</div>

					<div className="max-h-[300px] overflow-y-auto">
						{displayedIcons.length === 0 ? (
							<p className="py-3 text-muted-foreground text-sm">
								No icons found.
							</p>
						) : (
							<>
								<div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2">
									{displayedIcons.map((i) => (
										<button
											type="button"
											key={i.slug}
											onClick={() => handleIconSelect(i)}
											className="flex flex-col items-center gap-1.5 rounded-lg p-2 transition-colors hover:bg-muted"
										>
											<svg
												xmlns="http://www.w3.org/2000/svg"
												viewBox="0 0 24 24"
												className="size-7"
												fill={`#${i.hex}`}
											>
												<path d={i.path} />
											</svg>
											<span className="w-full truncate text-center text-muted-foreground text-xs capitalize">
												{i.title}
											</span>
										</button>
									))}
								</div>
								{hasMoreIcons && (
									<div className="flex justify-center mt-3">
										<Button
											variant="outline"
											size="sm"
											onClick={() => setIconsToShow((prev) => prev + 24)}
										>
											Show more ({filteredIcons.length - iconsToShow} left)
										</Button>
									</div>
								)}
							</>
						)}
					</div>

					<div className="space-y-2 border-t pt-4">
						<p className="font-medium text-sm">Upload your own</p>
						<Dropzone
							dropMessage="Drag & drop an icon or click to upload"
							accept=".jpg,.jpeg,.png,.svg,image/jpeg,image/png,image/svg+xml"
							onChange={handleFileUpload}
							classNameWrapper="rounded-lg border border-dashed bg-transparent bg-none py-0 shadow-none ring-0"
							classNameContent="h-24 [&_span]:text-sm"
						/>
						<p className="text-muted-foreground text-sm">
							JPG, PNG or SVG, up to 2 MB.
						</p>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
};
