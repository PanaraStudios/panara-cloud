"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import {
	Bookmark,
	BookText,
	CheckIcon,
	ChevronsUpDown,
	Globe,
	HelpCircle,
	LayoutGrid,
	List,
	Loader2,
	PuzzleIcon,
	SearchIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { GithubIcon } from "@/components/icons/data-tools-icons";
import { AlertBlock } from "@/components/shared/alert-block";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogClose,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { cn } from "@/lib/utils";

interface Props {
	/** Renders the form as a page instead of a dialog; called when it closes. */
	onDone?: () => void;
	environmentId: string;
	// The catalog is cached per instance, so its base URL is an instance
	// setting (edited here by instance administrators) instead of a prop.
	baseUrl?: string;
}

export const AddTemplate = ({ environmentId, onDone }: Props) => {
	const { active } = useOrganization();
	const [query, setQuery] = useState("");
	const [openState, setOpenState] = useState(false);
	const open = onDone ? true : openState;
	const setOpen = (open: boolean) => {
		setOpenState(open);
		if (!open) onDone?.();
	};
	const [viewMode, setViewMode] = useState<"detailed" | "icon">("detailed");
	const [selectedTags, setSelectedTags] = useState<string[]>([]);
	const [showBookmarksOnly, setShowBookmarksOnly] = useState(false);

	const baseUrlSettings = useQuery(
		api.platform.templates.baseUrlSettings,
		open ? {} : "skip",
	);
	const saveBaseUrl = useMutation(api.platform.templates.setBaseUrl);
	const [customBaseUrl, setCustomBaseUrl] = useState<string | undefined>(
		undefined,
	);
	const baseUrlValue = customBaseUrl ?? baseUrlSettings?.custom ?? "";
	const handleBaseUrlSave = async () => {
		if (!baseUrlSettings?.canEdit || customBaseUrl === undefined) return;
		const next = customBaseUrl.trim() || null;
		if (next === baseUrlSettings.custom) return;
		try {
			await saveBaseUrl({ baseUrl: next });
			setCustomBaseUrl(undefined);
			toast.success("Template base URL updated, refreshing the catalog");
		} catch (err) {
			toast.error(errorMessage(err) || "Failed to update the base URL");
		}
	};
	const showLocalOption = !useQuery(
		api.platform.deployTargets.remoteServersOnly,
		open ? {} : "skip",
	);
	const data = useQuery(api.platform.templates.list, open ? {} : "skip");
	const isLoadingTemplates = open && data === undefined;
	const servers = useQuery(api.servers.list, {
		organizationId: active.id,
	})?.filter((server) => server.sshKeyId);
	const tags = useQuery(api.platform.templates.tags, open ? {} : "skip");
	const isLoadingTags = tags === undefined;

	const bookmarkData = useQuery(
		api.platform.templates.listBookmarks,
		open ? { organizationId: active.id } : "skip",
	);
	const bookmarkIds = bookmarkData ?? [];
	const isLoadingBookmarks = open && bookmarkData === undefined;

	const setBookmark = useMutation(api.platform.templates.setBookmark);
	const toggleBookmark = async ({ templateId }: { templateId: string }) => {
		const bookmarked = !bookmarkIds.includes(templateId);
		await setBookmark({ organizationId: active.id, templateId, bookmarked })
			.then(() => {
				toast.success(
					bookmarked ? "Added to bookmarks" : "Removed from bookmarks",
				);
			})
			.catch(() => {
				toast.error("Failed to update bookmark");
			});
	};

	const [serverId, setServerId] = useState<string | undefined>(undefined);
	const deployTemplate = useAction(api.compose.templates.deployTemplate);
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const templates =
		data?.filter((template) => {
			const matchesTags =
				selectedTags.length === 0 ||
				template.tags.some((tag) => selectedTags.includes(tag));
			const matchesQuery =
				query === "" ||
				template.name.toLowerCase().includes(query.toLowerCase()) ||
				template.description.toLowerCase().includes(query.toLowerCase());
			const matchesBookmarks =
				!showBookmarksOnly || bookmarkIds.includes(template.templateId);
			return matchesTags && matchesQuery && matchesBookmarks;
		}) || [];

	const hasServers = servers && servers.length > 0;
	const shouldShowServerDropdown = hasServers;

	const handleToggleBookmark = async (
		e: React.MouseEvent,
		templateId: string,
	) => {
		e.stopPropagation();
		await toggleBookmark({ templateId });
	};

	const controls = (
		<div className="flex flex-col space-y-6">
			<div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
				{onDone ? (
					<div />
				) : (
					<div>
						<DialogTitle>Create from Template</DialogTitle>
						<DialogDescription>
							Create an open source application from a template
						</DialogDescription>
					</div>
				)}
				<div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
					<Input
						placeholder="Base URL (optional)"
						onChange={(e) => setCustomBaseUrl(e.target.value)}
						onBlur={() => void handleBaseUrlSave()}
						onKeyDown={(e) => {
							if (e.key === "Enter") void handleBaseUrlSave();
						}}
						disabled={!baseUrlSettings?.canEdit}
						title={
							baseUrlSettings?.canEdit
								? baseUrlSettings.defaultBaseUrl
									? `Default: ${baseUrlSettings.defaultBaseUrl}`
									: "Template catalog URL (none configured)"
								: "Only instance administrators can change the template base URL"
						}
						className="w-full sm:w-[300px]"
						value={baseUrlValue}
					/>
					<Input
						placeholder="Search Template"
						onChange={(e) => setQuery(e.target.value)}
						className="w-full"
						value={query}
					/>
					<Popover modal={true}>
						<PopoverTrigger
							render={
								<Button
									variant="outline"
									className={cn(
										"w-full sm:w-[200px] justify-between bg-input!",
									)}
								/>
							}
						>
							{isLoadingTags
								? "Loading...."
								: selectedTags.length > 0
									? `Selected ${selectedTags.length} tags`
									: "Select tag"}

							<ChevronsUpDown className="ml-2 h-4 w-4 opacity-50" />
						</PopoverTrigger>
						<PopoverContent
							className="w-(--anchor-width) min-w-56 p-0"
							align="start"
						>
							<Command>
								<CommandInput placeholder="Search tag..." className="h-9" />
								<CommandList className="max-h-none">
									{isLoadingTags && (
										<span className="py-6 text-center text-sm">
											Loading Tags....
										</span>
									)}
									<CommandEmpty>No tags found.</CommandEmpty>
									<ScrollArea className="h-96">
										<CommandGroup>
											{tags?.map((tag) => (
												<CommandItem
													value={tag}
													key={tag}
													onSelect={() => {
														if (selectedTags.includes(tag)) {
															setSelectedTags(
																selectedTags.filter((t) => t !== tag),
															);
															return;
														}
														setSelectedTags([...selectedTags, tag]);
													}}
												>
													{tag}
													<CheckIcon
														className={cn(
															"ml-auto h-4 w-4",
															selectedTags.includes(tag)
																? "opacity-100"
																: "opacity-0",
														)}
													/>
												</CommandItem>
											))}
										</CommandGroup>
									</ScrollArea>
								</CommandList>
							</Command>
						</PopoverContent>
					</Popover>
					<Button
						variant={showBookmarksOnly ? "default" : "outline"}
						size="icon"
						onClick={() => setShowBookmarksOnly(!showBookmarksOnly)}
						className="h-9 w-9 shrink-0"
						disabled={isLoadingBookmarks}
					>
						<Bookmark
							className={cn("size-4", showBookmarksOnly && "fill-current")}
						/>
					</Button>
					<Button
						size="icon"
						onClick={() =>
							setViewMode(viewMode === "detailed" ? "icon" : "detailed")
						}
						className="h-9 w-9 shrink-0"
					>
						{viewMode === "detailed" ? (
							<LayoutGrid className="size-4" />
						) : (
							<List className="size-4" />
						)}
					</Button>
				</div>
			</div>
			{selectedTags.length > 0 && (
				<div className="flex flex-wrap justify-end gap-2">
					{selectedTags.map((tag) => (
						<Badge
							key={tag}
							variant="secondary"
							className="cursor-pointer"
							onClick={() =>
								setSelectedTags(selectedTags.filter((t) => t !== tag))
							}
						>
							{tag} ×
						</Badge>
					))}
				</div>
			)}
		</div>
	);
	const body = (
		<>
			<ScrollArea className="h-[calc(98vh-8rem)]">
				<div className="p-6">
					{error && (
						<AlertBlock type="error" className="mb-4">
							{error}
						</AlertBlock>
					)}

					{isLoadingTemplates ? (
						<div className="flex justify-center items-center w-full h-full flex-row gap-4">
							<Loader2 className="size-8 text-muted-foreground animate-spin min-h-[60vh]" />
							<div className="text-lg font-medium text-muted-foreground">
								Loading templates...
							</div>
						</div>
					) : templates.length === 0 ? (
						<div className="flex flex-col justify-center items-center w-full gap-2 min-h-[50vh]">
							<SearchIcon className="text-muted-foreground size-6" />
							<div className="text-xl font-medium text-muted-foreground">
								{showBookmarksOnly
									? "No bookmarked templates found"
									: "No templates found"}
							</div>
							{showBookmarksOnly && (
								<p className="text-sm text-muted-foreground">
									Click the bookmark icon on templates to add them to bookmarks
								</p>
							)}
						</div>
					) : (
						<div
							className={cn(
								"grid gap-6",
								viewMode === "detailed"
									? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
									: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6",
							)}
						>
							{templates?.map((template, idx) => (
								<div
									key={`${template.templateId}-${template.version || "default"}-${idx}`}
									className={cn(
										"flex flex-col border rounded-lg overflow-hidden relative",
										viewMode === "icon" && "h-[200px]",
										viewMode === "detailed" && "h-[400px]",
									)}
								>
									<div className="absolute top-2 left-2 z-10">
										<Button
											variant="ghost"
											size="icon"
											className="h-8 w-8 bg-background/80 backdrop-blur-xs hover:bg-background"
											onClick={(e) =>
												handleToggleBookmark(e, template.templateId)
											}
										>
											<Bookmark
												className={cn(
													"size-4",
													bookmarkIds.includes(template.templateId) &&
														"fill-yellow-400 text-yellow-400",
												)}
											/>
										</Button>
									</div>
									<div className="absolute top-2 right-2">
										<Badge variant="info">{template?.version}</Badge>
									</div>
									<div
										className={cn(
											"flex-none p-6 pb-3 flex flex-col items-center gap-4 bg-muted/30",
											viewMode === "detailed" && "border-b",
										)}
									>
										{/** biome-ignore lint/performance/noImgElement: this is a valid use for img tag */}
										<img
											src={template.logoUrl ?? undefined}
											className={cn(
												"object-contain",
												viewMode === "detailed" ? "size-24" : "size-16",
											)}
											alt={template?.name}
										/>
										<div className="flex flex-col items-center gap-2">
											<span className="text-sm font-medium line-clamp-1">
												{template?.name}
											</span>
											{viewMode === "detailed" &&
												template?.tags?.length > 0 && (
													<div className="flex flex-wrap justify-center gap-1.5">
														{template.tags.slice(0, 6).map((tag) => (
															<Badge
																key={tag}
																variant="success"
																className="text-[10px] px-2 py-0"
															>
																{tag}
															</Badge>
														))}
														{template.tags.length > 6 && (
															<Badge
																variant="success"
																className="text-[10px] px-2 py-0"
																title={template.tags.slice(6).join(", ")}
															>
																+{template.tags.length - 6}
															</Badge>
														)}
													</div>
												)}
										</div>
									</div>

									{/* Template Content */}
									{viewMode === "detailed" && (
										<ScrollArea className="min-h-0 flex-1 p-6">
											<div className="text-sm text-muted-foreground">
												{template?.description}
											</div>
										</ScrollArea>
									)}

									{/* Create Button */}
									<div
										className={cn(
											"flex-none px-6 py-3 mt-auto",
											viewMode === "detailed"
												? "flex items-center justify-between bg-muted/30 border-t"
												: "flex justify-center",
										)}
									>
										{viewMode === "detailed" && (
											<div className="flex gap-2">
												{template?.links?.github && (
													<Link
														href={template?.links?.github}
														target="_blank"
														className="text-muted-foreground hover:text-foreground transition-colors"
													>
														<GithubIcon className="size-5" />
													</Link>
												)}
												{template?.links?.website && (
													<Link
														href={template?.links?.website}
														target="_blank"
														className="text-muted-foreground hover:text-foreground transition-colors"
													>
														<Globe className="size-5" />
													</Link>
												)}
												{template?.links?.docs && (
													<Link
														href={template?.links?.docs}
														target="_blank"
														className="text-muted-foreground hover:text-foreground transition-colors"
													>
														<BookText className="size-5" />
													</Link>
												)}
											</div>
										)}
										<AlertDialog>
											<AlertDialogTrigger
												render={
													<Button
														variant="secondary"
														size="sm"
														className={cn(
															"w-auto",
															viewMode === "detailed" && "w-auto",
														)}
													/>
												}
											>
												Create
											</AlertDialogTrigger>
											<AlertDialogContent className="data-[size=default]:max-w-lg data-[size=default]:sm:max-w-lg">
												<AlertDialogHeader>
													<AlertDialogTitle>
														Are you absolutely sure?
													</AlertDialogTitle>
													<AlertDialogDescription>
														This will create an application from the{" "}
														{template?.name} template and add it to your
														project.
													</AlertDialogDescription>

													{shouldShowServerDropdown && (
														<div>
															<TooltipProvider delay={0}>
																<Tooltip>
																	<TooltipTrigger
																		render={
																			<Label className="break-all w-fit flex flex-row gap-1 items-center pb-2 pt-3.5" />
																		}
																	>
																		Select a Server (Optional)
																		<HelpCircle className="size-4 text-muted-foreground" />
																	</TooltipTrigger>
																	<TooltipContent
																		className="z-999 w-[300px]"
																		align="start"
																		side="top"
																	>
																		<span>
																			If no server is selected, the application
																			will be deployed on the server where the
																			user is logged in.
																		</span>
																	</TooltipContent>
																</Tooltip>
															</TooltipProvider>

															<Select
																onValueChange={(e) => {
																	setServerId(e);
																}}
																defaultValue={
																	showLocalOption ? "local" : undefined
																}
															>
																<SelectTrigger className="w-full">
																	<SelectValue
																		placeholder={
																			showLocalOption
																				? "Panara Cloud"
																				: "Select a Server"
																		}
																	/>
																</SelectTrigger>
																<SelectContent>
																	<SelectGroup>
																		{showLocalOption && (
																			<SelectItem value="local">
																				<span className="flex items-center gap-2 justify-between w-full">
																					<span>Panara Cloud</span>
																					<span className="text-muted-foreground text-xs self-center">
																						Default
																					</span>
																				</span>
																			</SelectItem>
																		)}
																		{servers?.map((server) => (
																			<SelectItem
																				key={server._id}
																				value={server._id}
																			>
																				<span className="flex items-center gap-2 justify-between w-full">
																					<span>{server.name}</span>
																					<span className="text-muted-foreground text-xs self-center">
																						{server.ipAddress}
																					</span>
																				</span>
																			</SelectItem>
																		))}
																		<SelectLabel>
																			Servers (
																			{(servers?.length ?? 0) +
																				(showLocalOption ? 1 : 0)}
																			)
																		</SelectLabel>
																	</SelectGroup>
																</SelectContent>
															</Select>
														</div>
													)}
												</AlertDialogHeader>
												<AlertDialogFooter>
													<AlertDialogCancel>Cancel</AlertDialogCancel>
													<AlertDialogClose
														render={
															<AlertDialogAction
																disabled={isPending}
																onClick={async () => {
																	setIsPending(true);
																	setError(null);
																	const promise = deployTemplate({
																		serverId:
																			!serverId || serverId === "local"
																				? undefined
																				: (serverId as Id<"servers">),
																		environmentId:
																			environmentId as Id<"environments">,
																		templateId: template.templateId,
																	})
																		.catch((err) => {
																			setError(errorMessage(err));
																			throw err;
																		})
																		.finally(() => setIsPending(false));
																	toast.promise(promise, {
																		loading: "Setting up...",
																		success: () => {
																			setOpen(false);
																			return `${template.name} template created successfully`;
																		},
																		error: () => {
																			return `An error occurred deploying ${template.name} template`;
																		},
																	});
																}}
															/>
														}
													>
														Confirm
													</AlertDialogClose>
												</AlertDialogFooter>
											</AlertDialogContent>
										</AlertDialog>
									</div>
								</div>
							))}
						</div>
					)}
				</div>
			</ScrollArea>
		</>
	);
	if (onDone)
		return (
			<div className="flex flex-col gap-6">
				{controls}
				{body}
			</div>
		);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger className="w-full">
				<DropdownMenuItem
					className="w-full cursor-pointer space-x-3"
					closeOnClick={false}
				>
					<PuzzleIcon className="size-4 text-muted-foreground" />
					<span>Template</span>
				</DropdownMenuItem>
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-[90vw] p-0">
				<DialogHeader className="sticky top-0 z-10 bg-background p-6 border-b">
					{controls}
				</DialogHeader>
				{body}
			</DialogContent>
		</Dialog>
	);
};
