"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import { useAction, useQuery } from "convex/react";
import { CircleCheckIcon, InfoIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { CopyLinkField, useEmailEnabled } from "@/components/email/copy-link";
import { FormError } from "@/components/settings/form-kit";
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
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SegmentedToggle } from "@/components/ui/segmented-toggle";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";

const MIN_PASSWORD_LENGTH = 12;
const BUILT_IN_PROVIDER = "built-in";

const addInvitation = z
	.object({
		mode: z.enum(["invitation", "credentials"]),
		email: z
			.string()
			.trim()
			.min(1, "Email is required")
			.email({ message: "Invalid email" }),
		role: z.enum(["member", "admin"], { message: "Role is required" }),
		notificationId: z.string().optional(),
		password: z.string().optional(),
		confirmPassword: z.string().optional(),
	})
	.superRefine((value, ctx) => {
		if (value.mode !== "credentials") {
			return;
		}

		if (!value.password) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Password is required",
				path: ["password"],
			});
		} else if (value.password.length < MIN_PASSWORD_LENGTH) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
				path: ["password"],
			});
		}

		if (!value.confirmPassword) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Confirm password is required",
				path: ["confirmPassword"],
			});
		}

		if (
			value.password &&
			value.confirmPassword &&
			value.password !== value.confirmPassword
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Passwords do not match",
				path: ["confirmPassword"],
			});
		}
	});

type AddInvitation = z.infer<typeof addInvitation>;

export const AddInvitation = () => {
	const [open, setOpen] = useState(false);
	const { active } = useOrganization();
	const notifications = useQuery(api.platform.notifications.list, {
		organizationId: active.id,
	});
	const emailProviders = notifications?.filter(
		(notification) =>
			notification.channel.type === "email" ||
			notification.channel.type === "resend",
	);
	const inviteMember = useAction(api.users.invite);
	const createUserWithCredentials = useAction(api.users.createWithCredentials);
	const [isInviting, setIsInviting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const emailEnabled = useEmailEnabled();
	const [created, setCreated] = useState<{
		email: string;
		url: string;
		emailed: boolean;
		emailError: string | null;
	} | null>(null);

	const form = useForm<AddInvitation>({
		defaultValues: {
			mode: "invitation",
			email: "",
			role: "member",
			notificationId: BUILT_IN_PROVIDER,
			password: "",
			confirmPassword: "",
		},
		resolver: zodResolver(addInvitation),
	});

	const mode = form.watch("mode");

	useEffect(() => {
		if (!open) {
			form.reset();
			setError(null);
			setCreated(null);
		}
	}, [open, form, form.reset]);

	const onSubmit = async (data: AddInvitation) => {
		setError(null);
		setIsInviting(true);
		try {
			if (data.mode === "credentials") {
				await createUserWithCredentials({
					organizationId: active.id,
					email: data.email.toLowerCase(),
					password: data.password ?? "",
					role: data.role,
				});
				toast.success("User created with initial credentials");
			} else {
				const notificationId = emailProviders?.find(
					(provider) => provider._id === data.notificationId,
				)?._id;
				const result = await inviteMember({
					organizationId: active.id,
					email: data.email.toLowerCase(),
					role: data.role,
					notificationId,
				});
				// The dialog stays open on the link, emailed or not, so it can
				// always be handed over directly.
				setCreated({ email: data.email.toLowerCase(), ...result });
				return;
			}
			setOpen(false);
		} catch (error) {
			const message = errorMessage(error);
			setError(message);
			toast.error(message);
		} finally {
			setIsInviting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger className="" render={<Button />}>
				<PlusIcon data-icon="inline-start" />
				Invite member
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg">
				{created ? (
					<div className="flex flex-col gap-4">
						<DialogHeader>
							<DialogTitle className="flex items-center gap-2">
								<CircleCheckIcon className="size-4 text-success" />
								{mode === "credentials"
									? "Member created"
									: "Invitation created"}
							</DialogTitle>
							<DialogDescription>
								{created.emailError
									? `The invitation was created, but the email could not be sent (${created.emailError}). Send the link to ${created.email} yourself.`
									: created.emailed
										? `We emailed an invitation to ${created.email}. You can also send them this link yourself.`
										: `Send this link to ${created.email} yourself, over chat or email. Anyone with it can join as that address, so share it privately.`}
							</DialogDescription>
						</DialogHeader>
						<CopyLinkField url={created.url} label="Invitation link" />
						<p className="text-[13px] text-muted-foreground">
							Expires in 48 hours · you can copy it again from the members list
						</p>
						<DialogFooter className="sm:justify-between">
							<Button variant="ghost" onClick={() => setCreated(null)}>
								Invite another
							</Button>
							<Button variant="outline" onClick={() => setOpen(false)}>
								Done
							</Button>
						</DialogFooter>
					</div>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>Invite member</DialogTitle>
							<DialogDescription>
								They join {active.name}. Choose their project access after they
								accept.
							</DialogDescription>
						</DialogHeader>
						{error && <FormError title={error} />}
						<Form {...form}>
							<form
								id="hook-form-add-invitation"
								onSubmit={form.handleSubmit(onSubmit)}
								className="grid w-full gap-4"
							>
								<FormField
									control={form.control}
									name="email"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Email</FormLabel>
											<FormControl>
												<Input
													placeholder="name@example.com"
													autoFocus
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="role"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Role</FormLabel>
											<SegmentedToggle
												aria-label="Role"
												value={field.value as "member" | "admin"}
												onValueChange={field.onChange}
												className="w-full"
												itemClassName="flex-1"
												items={[
													{
														value: "member",
														label: "Member · only granted projects",
													},
													{ value: "admin", label: "Admin · everything" },
												]}
											/>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="mode"
									render={({ field }) => (
										<FormItem>
											<FormLabel>How they get in</FormLabel>
											<RadioGroup
												value={field.value}
												onValueChange={field.onChange}
												className="gap-0 divide-y divide-border overflow-hidden rounded-lg border border-border"
											>
												{(
													[
														[
															"invitation",
															"Invitation link",
															"You copy and send it. They set their own password.",
														],
														[
															"credentials",
															"Initial password",
															"You set a password now and share it securely.",
														],
													] as const
												).map(([value, title, description]) => (
													<label
														key={value}
														htmlFor={`invite-mode-${value}`}
														className="flex cursor-pointer items-start gap-3 p-3 has-data-checked:bg-muted/50"
													>
														<RadioGroupItem
															id={`invite-mode-${value}`}
															value={value}
															className="mt-0.5"
														/>
														<span className="flex flex-col">
															<span className="text-sm">{title}</span>
															<span className="text-[13px] text-muted-foreground">
																{description}
															</span>
														</span>
													</label>
												))}
											</RadioGroup>
											<FormMessage />
										</FormItem>
									)}
								/>
								{mode === "invitation" &&
								emailEnabled !== false &&
								(emailProviders?.length ?? 0) > 0 ? (
									<FormField
										control={form.control}
										name="notificationId"
										render={({ field }) => (
											<FormItem className="[&>button:has(+input:last-child)]:mb-0">
												<FormLabel>Send with</FormLabel>
												<Select
													onValueChange={field.onChange}
													value={field.value}
												>
													<FormControl>
														<SelectTrigger className="w-full">
															<SelectValue placeholder="Select an email provider" />
														</SelectTrigger>
													</FormControl>
													<SelectContent>
														<SelectItem value={BUILT_IN_PROVIDER}>
															Panara Cloud (built-in)
														</SelectItem>
														{emailProviders?.map((provider) => (
															<SelectItem
																key={provider._id}
																value={provider._id}
															>
																{provider.name}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
												<FormMessage />
											</FormItem>
										)}
									/>
								) : null}
								{mode === "invitation" && emailEnabled === false ? (
									<p className="flex items-center gap-2 text-[13px] text-muted-foreground">
										<InfoIcon className="size-3.5" />
										No email provider is set up, so nothing is emailed.
										<Link
											href="/settings/email"
											className="font-medium text-foreground hover:underline"
										>
											Set up email
										</Link>
									</p>
								) : null}
								{mode === "credentials" && (
									<div className="grid gap-4 sm:grid-cols-2">
										<FormField
											control={form.control}
											name="password"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Password</FormLabel>
													<FormControl>
														<Input
															type="password"
															autoComplete="new-password"
															{...field}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="confirmPassword"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Confirm</FormLabel>
													<FormControl>
														<Input
															type="password"
															autoComplete="new-password"
															{...field}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
									</div>
								)}
								<DialogFooter>
									<Button
										type="button"
										variant="outline"
										onClick={() => setOpen(false)}
									>
										Cancel
									</Button>
									<Button
										isLoading={isInviting}
										form="hook-form-add-invitation"
										type="submit"
									>
										{mode === "credentials"
											? "Create member"
											: "Create invitation"}
									</Button>
								</DialogFooter>
							</form>
						</Form>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
};
