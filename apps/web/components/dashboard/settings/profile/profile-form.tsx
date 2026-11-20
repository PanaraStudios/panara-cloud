"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import { Palette } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { SettingsCard } from "@/components/account/shared";
import { FormError } from "@/components/settings/form-kit";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { authClient } from "@/lib/auth/client";
import { errorMessage } from "@/lib/auth/errors";
import {
	getAvatarType,
	isSolidColorAvatar,
	isUploadedAvatar,
} from "@/lib/avatar-utils";
import { generateSHA256Hash, getFallbackAvatarInitials } from "@/lib/utils";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const UPLOAD_TYPES = "image/png,image/jpeg,image/gif,image/webp";

const profileSchema = z.object({
	image: z.string().optional(),
});

type Profile = z.infer<typeof profileSchema>;

const randomImages = [
	"/avatars/avatar-1.png",
	"/avatars/avatar-2.png",
	"/avatars/avatar-3.png",
	"/avatars/avatar-4.png",
	"/avatars/avatar-5.png",
	"/avatars/avatar-6.png",
	"/avatars/avatar-7.png",
	"/avatars/avatar-8.png",
	"/avatars/avatar-9.png",
	"/avatars/avatar-10.png",
	"/avatars/avatar-11.png",
	"/avatars/avatar-12.png",
];

// The profile form, reduced to the avatar: name, email, password, 2FA
// and passkeys are edited by the other cards on the account page.
export const ProfileForm = () => {
	const router = useRouter();
	const { data: session, isPending } = authClient.useSession();
	const currentUser = session?.user;
	const [isUpdating, setIsUpdating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [gravatarHash, setGravatarHash] = useState<string | null>(null);
	const colorInputRef = useRef<HTMLInputElement>(null);
	// The picked file waits here (the form holds its preview) until saved.
	const pendingUpload = useRef<File | null>(null);
	const generateUploadUrl = useMutation(api.account.generateAvatarUploadUrl);
	const updateAvatar = useMutation(api.account.updateAvatar);

	const availableAvatars = useMemo(() => {
		if (gravatarHash === null) return randomImages;
		return randomImages.concat([
			`https://www.gravatar.com/avatar/${gravatarHash}`,
		]);
	}, [gravatarHash]);

	const form = useForm<Profile>({
		defaultValues: {
			image: currentUser?.image || "",
		},
		resolver: zodResolver(profileSchema),
	});

	const savedImage = currentUser?.image || "";
	const email = currentUser?.email;
	useEffect(() => {
		form.reset({ image: savedImage });
	}, [form, savedImage]);

	useEffect(() => {
		if (email) {
			generateSHA256Hash(email).then((hash) => {
				setGravatarHash(hash);
			});
		}
	}, [email]);

	const onSubmit = async (values: Profile) => {
		setIsUpdating(true);
		setError(null);
		try {
			const file = values.image?.startsWith("data:")
				? pendingUpload.current
				: null;
			let storageId: string | undefined;
			if (file) {
				const response = await fetch(await generateUploadUrl(), {
					method: "POST",
					headers: { "Content-Type": file.type },
					body: file,
				});
				if (!response.ok) throw new Error("Upload failed");
				storageId = (await response.json()).storageId;
			}
			// Keeping the current uploaded image needs no update.
			if (storageId || !isUploadedAvatar(values.image)) {
				const result = await updateAvatar(
					storageId
						? { storageId: storageId as Id<"_storage"> }
						: { image: values.image || null },
				);
				if (result.error) throw new Error(result.error);
			}
			pendingUpload.current = null;
			authClient.$store.notify("$sessionSignal");
			router.refresh();
			toast.success("Profile updated");
		} catch (err) {
			setError(errorMessage(err));
			toast.error("Error updating the profile");
		} finally {
			setIsUpdating(false);
		}
	};

	return (
		<div className="w-full">
			<SettingsCard title="Avatar" description="Pick one, or upload your own.">
				{error && (
					<FormError title="Couldn't save the avatar." message={error} />
				)}
				{isPending ? (
					<p className="py-3 text-muted-foreground text-sm">Loading…</p>
				) : (
					<Form {...form}>
						<form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4">
							<div className="space-y-4">
								<FormField
									control={form.control}
									name="image"
									render={({ field }) => (
										<FormItem>
											<FormLabel className="sr-only">Avatar</FormLabel>
											<FormControl>
												<RadioGroup
													onValueChange={(e) => {
														field.onChange(e);
													}}
													defaultValue={getAvatarType(field.value)}
													value={getAvatarType(field.value)}
													className="flex flex-row flex-wrap gap-3 p-1"
												>
													<FormItem key="no-avatar">
														<FormLabel className="[&:has([data-checked])>.avatar-option]:ring-2 [&:has([data-checked])>.avatar-option]:ring-foreground [&:has([data-checked])>.avatar-option]:ring-offset-2 [&:has([data-checked])>.avatar-option]:ring-offset-background cursor-pointer">
															<FormControl>
																<RadioGroupItem
																	value=""
																	className="sr-only absolute!"
																/>
															</FormControl>

															<Avatar className="avatar-option size-10 rounded-full border border-border">
																<AvatarFallback className="text-xs">
																	{getFallbackAvatarInitials(
																		currentUser?.name ?? "",
																	)}
																</AvatarFallback>
															</Avatar>
														</FormLabel>
													</FormItem>
													<FormItem key="custom-upload">
														<FormLabel className="[&:has([data-checked])>.avatar-option]:ring-2 [&:has([data-checked])>.avatar-option]:ring-foreground [&:has([data-checked])>.avatar-option]:ring-offset-2 [&:has([data-checked])>.avatar-option]:ring-offset-background cursor-pointer">
															<FormControl>
																<RadioGroupItem
																	value="upload"
																	className="sr-only absolute!"
																/>
															</FormControl>
															<div
																className="avatar-option flex size-10 items-center justify-center overflow-hidden rounded-full border border-border border-dashed text-muted-foreground hover:text-foreground"
																onClick={() =>
																	document
																		.getElementById("avatar-upload")
																		?.click()
																}
															>
																{isUploadedAvatar(field.value) ? (
																	<img
																		src={field.value}
																		alt="Custom avatar"
																		className="h-full w-full object-cover rounded-full"
																	/>
																) : (
																	<svg
																		className="size-4"
																		fill="none"
																		stroke="currentColor"
																		viewBox="0 0 24 24"
																	>
																		<path
																			strokeLinecap="round"
																			strokeLinejoin="round"
																			strokeWidth={2}
																			d="M12 4v16m8-8H4"
																		/>
																	</svg>
																)}
															</div>
															<input
																id="avatar-upload"
																type="file"
																accept={UPLOAD_TYPES}
																className="hidden"
																onChange={async (e) => {
																	const file = e.target.files?.[0];
																	if (file) {
																		if (file.size > MAX_UPLOAD_BYTES) {
																			toast.error(
																				"Image size must be less than 2MB",
																			);
																			return;
																		}
																		pendingUpload.current = file;
																		const reader = new FileReader();
																		reader.onload = (event) => {
																			const result = event.target
																				?.result as string;
																			field.onChange(result);
																		};
																		reader.readAsDataURL(file);
																	}
																}}
															/>
														</FormLabel>
													</FormItem>
													<FormItem key="color-avatar">
														<FormLabel className="[&:has([data-checked])>.avatar-option]:ring-2 [&:has([data-checked])>.avatar-option]:ring-foreground [&:has([data-checked])>.avatar-option]:ring-offset-2 [&:has([data-checked])>.avatar-option]:ring-offset-background cursor-pointer relative">
															<FormControl>
																<RadioGroupItem
																	value="color"
																	className="sr-only absolute!"
																/>
															</FormControl>
															<div
																className="avatar-option flex size-10 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-border text-muted-foreground hover:text-foreground"
																style={{
																	backgroundColor: isSolidColorAvatar(
																		field.value,
																	)
																		? field.value
																		: undefined,
																}}
																onClick={() => colorInputRef.current?.click()}
															>
																{!isSolidColorAvatar(field.value) && (
																	<Palette className="size-4" />
																)}
															</div>
															<input
																ref={colorInputRef}
																type="color"
																className="pointer-events-none absolute top-0 left-0 size-10 opacity-0"
																value={field.value}
																onChange={field.onChange}
															/>
														</FormLabel>
													</FormItem>
													{availableAvatars.map((image) => (
														<FormItem key={image}>
															<FormLabel className="[&:has([data-checked])>.avatar-option]:ring-2 [&:has([data-checked])>.avatar-option]:ring-foreground [&:has([data-checked])>.avatar-option]:ring-offset-2 [&:has([data-checked])>.avatar-option]:ring-offset-background cursor-pointer">
																<FormControl>
																	<RadioGroupItem
																		value={image}
																		className="sr-only absolute!"
																	/>
																</FormControl>

																<img
																	key={image}
																	src={image}
																	alt="avatar"
																	className="avatar-option size-10 rounded-full border border-border"
																/>
															</FormLabel>
														</FormItem>
													))}
												</RadioGroup>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
							</div>

							<div className="flex justify-end">
								<Button
									type="submit"
									size="sm"
									isLoading={isUpdating}
									disabled={!form.formState.isDirty}
								>
									Save avatar
								</Button>
							</div>
						</form>
					</Form>
				)}
			</SettingsCard>
		</div>
	);
};
