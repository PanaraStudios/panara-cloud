"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { Palette, PenBoxIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { FormError } from "@/components/settings/form-kit";
import { TagBadge } from "@/components/shared/tag-badge";
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
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { cn } from "@/lib/utils";

const TagSchema = z.object({
	name: z
		.string()
		.min(1, "Tag name is required")
		.max(50, "Tag name must be less than 50 characters")
		.refine(
			(name) => {
				const trimmedName = name.trim();
				const validNameRegex =
					/^[\p{L}\p{N}_-][\p{L}\p{N}\s_.-]*[\p{L}\p{N}_-]$/u;
				return validNameRegex.test(trimmedName);
			},
			{
				message:
					"Tag name must start and end with a letter, number, hyphen or underscore. Spaces are allowed in between.",
			},
		)
		.transform((name) => name.trim()),
	color: z.string().optional(),
});

type Tag = z.infer<typeof TagSchema>;

interface HandleTagProps {
	tagId?: string;
	/**
	 * Called with the new tag's id after it is created, so callers embedding
	 * this dialog (e.g. the tag selector) can select the tag right away.
	 */
	onCreated?: (tagId: string) => void;
	/** Render the edit trigger as a row menu's "Edit" item. */
	asMenuItem?: boolean;
}

const SWATCHES = [
	"#71717a",
	"#2563eb",
	"#16a34a",
	"#d97706",
	"#dc2626",
	"#7c3aed",
] as const;

export const HandleTag = ({ tagId, onCreated, asMenuItem }: HandleTagProps) => {
	const { active } = useOrganization();
	const [isOpen, setIsOpen] = useState(false);
	const colorInputRef = useRef<HTMLInputElement>(null);
	const [error, setError] = useState<string | null>(null);

	const createTag = useMutation(api.platform.tags.create);
	const updateTag = useMutation(api.platform.tags.update);

	const tag = useQuery(
		api.platform.tags.get,
		tagId ? { tagId: tagId as Id<"tags"> } : "skip",
	);

	const form = useForm<Tag>({
		defaultValues: {
			name: "",
			color: "#3b82f6",
		},
		resolver: zodResolver(TagSchema),
	});

	useEffect(() => {
		if (tag) {
			form.reset({
				name: tag.name ?? "",
				color: tag.color ?? "#3b82f6",
			});
		} else {
			form.reset({
				name: "",
				color: "#3b82f6",
			});
		}
	}, [form, form.reset, tag]);

	const onSubmit = async (data: Tag) => {
		setError(null);
		try {
			if (tagId) {
				await updateTag({
					tagId: tagId as Id<"tags">,
					name: data.name,
					color: data.color,
				});
			} else {
				const createdId = await createTag({
					organizationId: active.id,
					name: data.name,
					color: data.color,
				});
				onCreated?.(createdId);
			}
			toast.success(tagId ? "Tag Updated" : "Tag Created");
			setIsOpen(false);
			form.reset();
		} catch (err) {
			setError(errorMessage(err));
			toast.error(tagId ? "Error updating tag" : "Error creating tag");
		}
	};

	const colorValue = form.watch("color");

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			{asMenuItem ? (
				<DialogTrigger
					role="menuitem"
					nativeButton={false}
					render={<DropdownMenuItem closeOnClick={false} />}
				>
					Edit
				</DialogTrigger>
			) : (
				<DialogTrigger
					render={
						tagId ? (
							<Button variant="ghost" size="icon-sm" aria-label="Edit tag" />
						) : (
							<Button />
						)
					}
				>
					{tagId ? (
						<PenBoxIcon />
					) : (
						<>
							<PlusIcon data-icon="inline-start" />
							Add tag
						</>
					)}
				</DialogTrigger>
			)}
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{tagId ? "Edit tag" : "Add tag"}</DialogTitle>
					<DialogDescription>
						Tags label projects, so the projects list can be filtered.
					</DialogDescription>
				</DialogHeader>
				{error && <FormError title="Couldn't save the tag." message={error} />}
				<Form {...form}>
					{/*
					 * This dialog can be rendered inside another form (e.g. the tag
					 * selector in the project dialog). React propagates events through the
					 * React tree, not the DOM tree, so without stopPropagation submitting
					 * this form would also submit the outer one.
					 */}
					<form
						method="post"
						id="hook-form-tag"
						onSubmit={(e) => {
							e.stopPropagation();
							form.handleSubmit(onSubmit)(e);
						}}
						className="grid w-full gap-4"
					>
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input placeholder="Production" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="color"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Color</FormLabel>
									<div className="flex flex-wrap items-center gap-3">
										<div className="flex items-center gap-1.5">
											{SWATCHES.map((swatch) => (
												<button
													key={swatch}
													type="button"
													aria-pressed={field.value === swatch}
													aria-label={`Color ${swatch}`}
													onClick={() => field.onChange(swatch)}
													className={cn(
														"size-5 rounded-full ring-offset-2 ring-offset-background",
														field.value === swatch &&
															"ring-2 ring-foreground/60",
													)}
													style={{ backgroundColor: swatch }}
												/>
											))}
											<button
												type="button"
												aria-label="Custom color"
												onClick={() => colorInputRef.current?.click()}
												className="relative flex size-5 items-center justify-center rounded-full border border-border text-muted-foreground"
											>
												<Palette className="size-3" />
												<input
													ref={colorInputRef}
													type="color"
													tabIndex={-1}
													className="pointer-events-none absolute inset-0 size-5 opacity-0"
													value={field.value || "#3b82f6"}
													onChange={field.onChange}
												/>
											</button>
										</div>
										<FormControl>
											<Input
												placeholder="#3b82f6"
												className="w-28 font-mono text-[13px]"
												{...field}
												value={field.value || ""}
												onChange={(e) => {
													const value = e.target.value;
													if (value.startsWith("#") || value === "") {
														field.onChange(value);
													}
												}}
											/>
										</FormControl>
										{colorValue ? (
											<TagBadge
												name={form.watch("name") || "Preview"}
												color={colorValue}
											/>
										) : null}
									</div>
									<FormMessage />
								</FormItem>
							)}
						/>
					</form>
				</Form>

				<DialogFooter>
					<Button
						isLoading={form.formState.isSubmitting}
						form="hook-form-tag"
						type="submit"
					>
						{tagId ? "Save" : "Add tag"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
