"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { BuildTypeIcon } from "@/components/icons/service-icons";
import { FilterPills } from "@/components/service/filter-pills";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { FormActions, FormSection, SaveButton } from "../form-kit";
import { useApplication } from "../use-application";

// Railpack versions from https://github.com/railwayapp/railpack/releases
export const RAILPACK_VERSIONS = [
	"0.39.0",
	"0.38.0",
	"0.37.1",
	"0.37.0",
	"0.36.4",
	"0.36.3",
	"0.36.2",
	"0.36.1",
	"0.36.0",
	"0.35.0",
	"0.34.0",
	"0.33.0",
	"0.32.0",
	"0.31.2",
	"0.31.1",
	"0.31.0",
	"0.30.1",
	"0.30.0",
	"0.29.0",
	"0.28.0",
	"0.27.2",
	"0.27.1",
	"0.27.0",
	"0.26.1",
	"0.26.0",
	"0.25.0",
	"0.24.0",
	"0.23.0",
	"0.22.2",
	"0.22.1",
	"0.22.0",
	"0.21.0",
	"0.20.0",
	"0.19.0",
	"0.18.0",
	"0.17.2",
	"0.17.1",
	"0.17.0",
	"0.16.0",
	"0.15.4",
	"0.15.3",
	"0.15.2",
	"0.15.1",
	"0.15.0",
	"0.14.0",
	"0.13.0",
	"0.12.0",
	"0.11.0",
	"0.10.0",
	"0.9.2",
	"0.9.1",
	"0.9.0",
	"0.8.0",
	"0.7.2",
	"0.7.1",
	"0.7.0",
	"0.6.1",
	"0.6.0",
	"0.5.1",
	"0.5.0",
	"0.4.0",
	"0.3.0",
	"0.2.3",
	"0.2.2",
	"0.2.1",
	"0.2.0",
	"0.1.2",
	"0.1.1",
	"0.1.0",
] as const;

export enum BuildType {
	dockerfile = "dockerfile",
	heroku_buildpacks = "heroku_buildpacks",
	paketo_buildpacks = "paketo_buildpacks",
	nixpacks = "nixpacks",
	static = "static",
	railpack = "railpack",
}

const buildTypeDisplayMap: Record<BuildType, string> = {
	[BuildType.dockerfile]: "Dockerfile",
	[BuildType.railpack]: "Railpack",
	[BuildType.nixpacks]: "Nixpacks",
	[BuildType.heroku_buildpacks]: "Heroku Buildpacks",
	[BuildType.paketo_buildpacks]: "Paketo Buildpacks",
	[BuildType.static]: "Static",
};

const mySchema = z.discriminatedUnion("buildType", [
	z.object({
		buildType: z.literal(BuildType.dockerfile),
		dockerfile: z.string().nullable().default(""),
		dockerContextPath: z.string().nullable().default(""),
		dockerBuildStage: z.string().nullable().default(""),
	}),
	z.object({
		buildType: z.literal(BuildType.heroku_buildpacks),
		herokuVersion: z.string().nullable().default(""),
	}),
	z.object({
		buildType: z.literal(BuildType.paketo_buildpacks),
	}),
	z.object({
		buildType: z.literal(BuildType.nixpacks),
		publishDirectory: z.string().optional(),
		isStaticSpa: z.boolean().default(false),
	}),
	z.object({
		buildType: z.literal(BuildType.railpack),
		railpackVersion: z.string().nullable().default("0.15.4"),
	}),
	z.object({
		buildType: z.literal(BuildType.static),
		isStaticSpa: z.boolean().default(false),
	}),
]);

type AddTemplate = z.infer<typeof mySchema>;

interface Props {
	applicationId: string;
}

interface ApplicationData {
	buildType: BuildType;
	dockerfile?: string | null;
	dockerContextPath?: string | null;
	dockerBuildStage?: string | null;
	herokuVersion?: string | null;
	publishDirectory?: string | null;
	isStaticSpa?: boolean | null;
	railpackVersion?: string | null | undefined;
}

function isValidBuildType(value: string): value is BuildType {
	return Object.values(BuildType).includes(value as BuildType);
}

const resetData = (data: ApplicationData): AddTemplate => {
	switch (data.buildType) {
		case BuildType.dockerfile:
			return {
				buildType: BuildType.dockerfile,
				dockerfile: data.dockerfile || "",
				dockerContextPath: data.dockerContextPath || "",
				dockerBuildStage: data.dockerBuildStage || "",
			};
		case BuildType.heroku_buildpacks:
			return {
				buildType: BuildType.heroku_buildpacks,
				herokuVersion: data.herokuVersion || "",
			};
		case BuildType.nixpacks:
			return {
				buildType: BuildType.nixpacks,
				publishDirectory: data.publishDirectory || undefined,
				isStaticSpa: data.isStaticSpa ?? false,
			};
		case BuildType.paketo_buildpacks:
			return {
				buildType: BuildType.paketo_buildpacks,
			};
		case BuildType.static:
			return {
				buildType: BuildType.static,
				isStaticSpa: data.isStaticSpa ?? false,
			};
		case BuildType.railpack:
			return {
				buildType: BuildType.railpack,
				railpackVersion: data.railpackVersion || null,
			};
		default: {
			const buildType = data.buildType as BuildType;
			return {
				buildType,
			} as AddTemplate;
		}
	}
};

export const ShowBuildChooseForm = ({ applicationId }: Props) => {
	const saveBuildType = useMutation(
		api.applications.applications.saveBuildType,
	);
	const [isPending, setIsPending] = useState(false);
	const data = useApplication(applicationId);

	const form = useForm({
		defaultValues: {
			buildType: BuildType.nixpacks,
		},
		resolver: zodResolver(mySchema),
	});

	const buildType = form.watch("buildType");
	const railpackVersion = form.watch("railpackVersion");
	const publishDirectory = form.watch("publishDirectory");
	const [isManualRailpackVersion, setIsManualRailpackVersion] = useState(false);

	useEffect(() => {
		if (data) {
			const typedData: ApplicationData = {
				...data,
				buildType: isValidBuildType(data.buildType)
					? (data.buildType as BuildType)
					: BuildType.nixpacks, // fallback
			};

			form.reset(resetData(typedData));

			// Check if railpack version is manual (not in the predefined list)
			if (
				data.railpackVersion &&
				!RAILPACK_VERSIONS.includes(data.railpackVersion as any)
			) {
				setIsManualRailpackVersion(true);
			}
		}
	}, [data, form]);

	// Hide builder section when Docker provider is selected
	if (data?.sourceType === "docker") {
		return null;
	}

	const onSubmit = async (data: AddTemplate) => {
		setIsPending(true);
		await saveBuildType({
			applicationId: applicationId as Id<"applications">,
			type: data.buildType,
			publishDirectory:
				data.buildType === BuildType.nixpacks
					? (data.publishDirectory ?? "")
					: "",
			dockerfile:
				data.buildType === BuildType.dockerfile
					? data.dockerfile || undefined
					: undefined,
			dockerContextPath:
				data.buildType === BuildType.dockerfile
					? (data.dockerContextPath ?? "")
					: "",
			dockerBuildStage:
				data.buildType === BuildType.dockerfile
					? (data.dockerBuildStage ?? "")
					: "",
			herokuVersion:
				data.buildType === BuildType.heroku_buildpacks
					? data.herokuVersion || undefined
					: undefined,
			isStaticSpa:
				data.buildType === BuildType.static ||
				data.buildType === BuildType.nixpacks
					? data.isStaticSpa
					: false,
			railpackVersion:
				data.buildType === BuildType.railpack
					? data.railpackVersion || "0.15.4"
					: undefined,
		})
			.then(() => {
				toast.success("Build type saved");
			})
			.catch(() => {
				toast.error("Error saving the build type");
			})
			.finally(() => setIsPending(false));
	};

	return (
		<FormSection
			title="Build type"
			description="How the code becomes an image. Builders need about 4 GB of RAM and 2 CPU cores."
		>
			<Form {...form}>
				<form
					onSubmit={form.handleSubmit(onSubmit)}
					className="grid w-full gap-4"
				>
					<FormField
						control={form.control}
						name="buildType"
						defaultValue={form.control._defaultValues.buildType}
						render={({ field }) => (
							<FormItem className="space-y-2">
								<FormControl>
									<div className="w-full overflow-x-auto">
										<FilterPills
											aria-label="Builder"
											className="w-fit"
											value={field.value}
											onValueChange={field.onChange}
											items={Object.entries(buildTypeDisplayMap).map(
												([value, label]) => ({
													value,
													label,
													icon: <BuildTypeIcon type={value} />,
												}),
											)}
										/>
									</div>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					{buildType === BuildType.heroku_buildpacks && (
						<FormField
							control={form.control}
							name="herokuVersion"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Heroku version (optional)</FormLabel>
									<FormControl>
										<Input
											placeholder="24"
											{...field}
											value={field.value ?? ""}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					)}
					{buildType === BuildType.dockerfile && (
						<>
							<FormField
								control={form.control}
								name="dockerfile"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel>Dockerfile path</FormLabel>
										<FormControl>
											<Input
												placeholder="Dockerfile"
												{...field}
												value={field.value ?? ""}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="dockerContextPath"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel>Build context</FormLabel>
										<FormControl>
											<Input
												placeholder="."
												{...field}
												value={field.value ?? ""}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="dockerBuildStage"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel>Build stage</FormLabel>
										<FormControl>
											<Input
												placeholder="production"
												{...field}
												value={field.value ?? ""}
											/>
										</FormControl>
										<FormDescription>
											The stage of a multi-stage Dockerfile to build. Empty
											builds the last one.
										</FormDescription>
									</FormItem>
								)}
							/>
						</>
					)}
					{buildType === BuildType.nixpacks && (
						<FormField
							control={form.control}
							name="publishDirectory"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Publish directory</FormLabel>
									<FormControl>
										<Input
											placeholder="e.g. dist"
											{...field}
											value={field.value ?? ""}
										/>
									</FormControl>
									<FormDescription>
										Optional. Serves this directory as a static site with NGINX
										after the build.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
					)}
					{buildType === BuildType.nixpacks && publishDirectory && (
						<FormField
							control={form.control}
							name="isStaticSpa"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormControl>
										<div className="flex items-center gap-2">
											<Checkbox
												id="checkboxIsStaticSpaNixpacks"
												value={String(field.value)}
												checked={field.value}
												onCheckedChange={field.onChange}
											/>
											<FormLabel htmlFor="checkboxIsStaticSpaNixpacks">
												Single page application (SPA)
											</FormLabel>
										</div>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					)}
					{buildType === BuildType.static && (
						<FormField
							control={form.control}
							name="isStaticSpa"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormControl>
										<div className="flex items-center gap-2">
											<Checkbox
												id="checkboxIsStaticSpa"
												value={String(field.value)}
												checked={field.value}
												onCheckedChange={field.onChange}
											/>
											<FormLabel htmlFor="checkboxIsStaticSpa">
												Single page application (SPA)
											</FormLabel>
										</div>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					)}
					{buildType === BuildType.railpack && (
						<>
							<FormField
								control={form.control}
								name="railpackVersion"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel>Railpack version</FormLabel>
										<FormControl>
											{isManualRailpackVersion ? (
												<div className="flex gap-2">
													<Input
														placeholder="0.15.4"
														{...field}
														value={field.value ?? ""}
													/>
													<Button
														type="button"
														variant="outline"
														onClick={() => {
															setIsManualRailpackVersion(false);
															field.onChange("0.15.4");
														}}
													>
														Pick from list
													</Button>
												</div>
											) : (
												<Select
													onValueChange={(value) => {
														if (value === "manual") {
															setIsManualRailpackVersion(true);
															field.onChange("");
														} else {
															field.onChange(value);
														}
													}}
													value={field.value ?? "0.15.4"}
												>
													<SelectTrigger className="w-full">
														<SelectValue placeholder="Select Railpack version" />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value="manual">
															Custom version…
														</SelectItem>
														{RAILPACK_VERSIONS.map((version) => (
															<SelectItem key={version} value={version}>
																v{version}
																{version === "0.15.4" && (
																	<Badge
																		variant="secondary"
																		className="ml-2 px-1 text-xs"
																	>
																		Latest
																	</Badge>
																)}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
											)}
										</FormControl>
										<FormDescription>
											See what changed in the{" "}
											<a
												href="https://github.com/railwayapp/railpack/releases"
												target="_blank"
												rel="noreferrer"
												className="font-medium text-foreground underline-offset-4 hover:underline"
											>
												Railpack releases
											</a>
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
						</>
					)}
					<FormActions>
						<SaveButton isLoading={isPending} dirty={form.formState.isDirty} />
					</FormActions>
				</form>
			</Form>
		</FormSection>
	);
};
