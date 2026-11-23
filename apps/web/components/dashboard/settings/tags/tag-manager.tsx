"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import { TagIcon } from "lucide-react";
import { toast } from "sonner";
import { LogoTile } from "@/components/icons/settings-icons";
import { ListLoading } from "@/components/settings/form-kit";
import { TableCell, TableRow } from "@/components/ui/table";
import { PageHeader, ResourceTable, Th } from "@/components/ui-kit/primitives";
import { RowMenu, SettingsEmpty } from "@/components/ui-kit/settings-list";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { HandleTag } from "./handle-tag";

export const TagManager = () => {
	const { active } = useOrganization();
	const tags = useQuery(api.platform.tags.list, {
		organizationId: active.id,
	});
	const projects = useQuery(api.projects.all, { organizationId: active.id });
	const isPending = tags === undefined;
	const deleteTag = useMutation(api.platform.tags.remove);
	const permissions = usePermissions();
	const projectsFor = (tagId: string) =>
		(projects ?? [])
			.filter((project) => project.tags.some((tag) => tag.tagId === tagId))
			.map((project) => project.name);

	return (
		<div className="flex w-full flex-col gap-6">
			<PageHeader
				title="Tags"
				description="Label projects so the projects list can be filtered, e.g. by client or team."
			>
				{permissions?.tag.create ? <HandleTag /> : null}
			</PageHeader>
			{isPending ? (
				<ListLoading />
			) : !tags || tags.length === 0 ? (
				<SettingsEmpty
					icon={TagIcon}
					title="No tags yet"
					description="Add a tag, then pick it on a project."
				/>
			) : (
				<ResourceTable
					headers={
						<>
							<Th>Tag</Th>
							<Th>Projects</Th>
							<Th className="w-12" />
						</>
					}
				>
					{tags.map((tag) => {
						const used = projectsFor(tag._id);
						return (
							<TableRow key={tag._id}>
								<TableCell>
									<span className="flex items-center gap-3 font-medium">
										<LogoTile>
											<span
												className="size-2.5 rounded-full bg-muted-foreground/50"
												style={
													tag.color ? { backgroundColor: tag.color } : undefined
												}
											/>
										</LogoTile>
										{tag.name}
									</span>
								</TableCell>
								<TableCell
									className={used.length ? undefined : "text-muted-foreground"}
								>
									{used.length ? used.join(", ") : "Not used yet"}
								</TableCell>
								<TableCell className="text-right">
									<RowMenu
										label={tag.name}
										deleteTitle="Delete tag?"
										deleteDescription={`"${tag.name}" is removed from every project. This can't be undone.`}
										onDelete={
											permissions?.tag.delete
												? async () => {
														await deleteTag({ tagId: tag._id })
															.then(() => toast.success("Tag deleted"))
															.catch(() => toast.error("Error deleting tag"));
													}
												: undefined
										}
									>
										{permissions?.tag.update ? (
											<HandleTag tagId={tag._id} asMenuItem />
										) : null}
									</RowMenu>
								</TableCell>
							</TableRow>
						);
					})}
				</ResourceTable>
			)}
		</div>
	);
};
