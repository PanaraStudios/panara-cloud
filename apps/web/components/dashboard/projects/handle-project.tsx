"use client";

import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";

import { PlusIcon, SquarePen } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { FormFooter } from "@/components/service-settings/form-footer";
import { AlertBlock } from "@/components/shared/alert-block";
import { TagSelector } from "@/components/shared/tag-selector";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
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
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";

const AddProjectSchema = z.object({
	name: z
		.string()
		.min(1, "Project name is required")
		.refine(
			(name) => {
				const trimmedName = name.trim();
				const validNameRegex =
					/^[\p{L}\p{N}_-][\p{L}\p{N}\s_.-]*[\p{L}\p{N}_-]$/u;
				return validNameRegex.test(trimmedName);
			},
			{
				message:
					"Project name must start and end with a letter, number, hyphen or underscore. Spaces are allowed in between.",
			},
		)
		.refine((name) => !/^\d/.test(name.trim()), {
			message: "Project name cannot start with a number",
		})
		.transform((name) => name.trim()),
	description: z.string().optional(),
});

type AddProject = z.infer<typeof AddProjectSchema>;

interface Props {
	/** Renders the form as a page instead of a dialog; called when it closes. */
	onDone?: () => void;
	projectId?: string;
}

export const HandleProject = ({ projectId, onDone }: Props) => {
	const { active } = useOrganization();
	const [isOpenState, setIsOpenState] = useState(false);
	const isOpen = onDone ? true : isOpenState;
	const setIsOpen = (open: boolean) => {
		setIsOpenState(open);
		if (!open) onDone?.();
	};
	const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);

	const createProject = useMutation(api.projects.create);
	const updateProject = useMutation(api.projects.update);

	const data = useQuery(
		api.projects.get,
		projectId ? { projectId: projectId as Id<"projects"> } : "skip",
	);
	const projectTags = useQuery(
		api.platform.tags.forProject,
		projectId ? { projectId: projectId as Id<"projects"> } : "skip",
	);

	const availableTags =
		useQuery(api.platform.tags.list, { organizationId: active.id }) ?? [];
	const setProjectTags = useMutation(api.platform.tags.setProjectTags);

	const router = useRouter();
	const form = useForm<AddProject>({
		defaultValues: {
			description: "",
			name: "",
		},
		resolver: standardSchemaResolver(AddProjectSchema),
	});

	useEffect(() => {
		form.reset({
			description: data?.description ?? "",
			name: data?.name ?? "",
		});
		// Load existing tags when editing a project
		if (projectTags) {
			setSelectedTagIds(projectTags.map((tag) => tag._id));
		} else {
			setSelectedTagIds([]);
		}
	}, [form, form.reset, form.formState.isSubmitSuccessful, data, projectTags]);

	const onSubmit = async (data: AddProject) => {
		setError(null);
		try {
			let projectIdToUse = projectId as Id<"projects"> | undefined;
			let environmentIdToUse: Id<"environments"> | undefined;
			if (projectIdToUse) {
				await updateProject({
					projectId: projectIdToUse,
					name: data.name,
					description: data.description,
				});
			} else {
				const created = await createProject({
					organizationId: active.id,
					name: data.name,
					description: data.description,
				});
				projectIdToUse = created.projectId;
				environmentIdToUse = created.environmentId;
			}

			// Assign tags to the project (both create and update)
			try {
				await setProjectTags({
					projectId: projectIdToUse,
					tagIds: selectedTagIds as Id<"tags">[],
				});
			} catch {
				toast.error("Failed to assign tags to project");
			}

			toast.success(projectId ? "Project Updated" : "Project Created");
			setIsOpen(false);
			if (!projectId && environmentIdToUse) {
				router.push(
					`/projects/${projectIdToUse}/environment/${environmentIdToUse}`,
				);
			}
		} catch (err) {
			setError(errorMessage(err));
			toast.error(
				projectId ? "Error updating a project" : "Error creating a project",
			);
		}
	};

	const body = (
		<>
			{error && <AlertBlock type="error">{error}</AlertBlock>}
			<Form {...form}>
				<form
					id="hook-form-add-project"
					onSubmit={form.handleSubmit(onSubmit)}
					className="grid w-full gap-4"
				>
					<div className="flex flex-col gap-4">
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input placeholder="Vandelay Industries" {...field} />
									</FormControl>

									<FormMessage />
								</FormItem>
							)}
						/>
					</div>

					<FormField
						control={form.control}
						name="description"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Description</FormLabel>
								<FormControl>
									<Textarea
										placeholder="Description about your project..."
										className="resize-none"
										{...field}
									/>
								</FormControl>

								<FormMessage />
							</FormItem>
						)}
					/>

					<div className="space-y-2">
						<FormLabel>Tags</FormLabel>
						<TagSelector
							tags={availableTags.map((tag) => ({
								id: tag._id,
								name: tag.name,
								color: tag.color ?? undefined,
							}))}
							selectedTags={selectedTagIds}
							onTagsChange={setSelectedTagIds}
							placeholder="Select tags..."
						/>
					</div>
				</form>

				<FormFooter page={!!onDone}>
					<Button
						isLoading={form.formState.isSubmitting}
						form="hook-form-add-project"
						type="submit"
					>
						{projectId ? "Update" : "Create"}
					</Button>
				</FormFooter>
			</Form>
		</>
	);
	if (onDone)
		return <div className="flex max-w-3xl flex-col gap-6">{body}</div>;

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger
				render={
					(projectId ? (
						<DropdownMenuItem
							className="w-full cursor-pointer space-x-3"
							closeOnClick={false}
						>
							<SquarePen className="size-4" />
							<span>Update</span>
						</DropdownMenuItem>
					) : (
						<Button>
							<PlusIcon data-icon="inline-start" />
							New project
						</Button>
					)) as React.ReactElement
				}
				nativeButton={!projectId}
			/>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:m:max-w-lg">
				<DialogHeader>
					<DialogTitle>{projectId ? "Update" : "Add a"} project</DialogTitle>
					<DialogDescription>The home of something big!</DialogDescription>
				</DialogHeader>
				{body}
			</DialogContent>
		</Dialog>
	);
};
