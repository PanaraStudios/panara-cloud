"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import { useAction } from "convex/react";
import copy from "copy-to-clipboard";
import { CopyIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
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
import { Switch } from "@/components/ui/switch";
import { BackLink } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization, useOrganizations } from "@/lib/organization";

const API_KEY_NAME_MAX_LENGTH = 32;

const apiKeyNameSchema = z
	.string()
	.trim()
	.min(1, "Name is required")
	.max(
		API_KEY_NAME_MAX_LENGTH,
		`Name must be at most ${API_KEY_NAME_MAX_LENGTH} characters`,
	);

// Without a custom prefix keys start with "pnr_"; without per-key rate
// limiting they share the instance default (API_RATE_LIMIT_PER_MINUTE).
const formSchema = z
	.object({
		name: apiKeyNameSchema,
		prefix: z
			.string()
			.trim()
			.regex(/^[A-Za-z0-9_-]{0,32}$/, {
				message: "Up to 32 letters, digits, underscores or dashes",
			})
			.optional(),
		expiresIn: z.number().nullable(),
		organizationId: z.string().min(1, "Organization is required"),
		// Rate limiting fields
		rateLimitEnabled: z.boolean().optional(),
		rateLimitTimeWindow: z.number().nullable(),
		rateLimitMax: z.number().int().positive().nullable(),
		// Request limiting fields
		remaining: z.number().int().positive().nullable().optional(),
		refillAmount: z.number().int().positive().nullable().optional(),
		refillInterval: z.number().nullable().optional(),
	})
	.superRefine((value, ctx) => {
		if (value.rateLimitEnabled && !value.rateLimitTimeWindow) {
			ctx.addIssue({
				code: "custom",
				message: "Select a time window",
				path: ["rateLimitTimeWindow"],
			});
		}
		if (value.rateLimitEnabled && !value.rateLimitMax) {
			ctx.addIssue({
				code: "custom",
				message: "Maximum requests is required",
				path: ["rateLimitMax"],
			});
		}
		if (!value.refillAmount !== !value.refillInterval) {
			ctx.addIssue({
				code: "custom",
				message: "Set both the refill amount and the refill interval",
				path: [value.refillAmount ? "refillInterval" : "refillAmount"],
			});
		}
		if (value.refillAmount && !value.remaining) {
			ctx.addIssue({
				code: "custom",
				message: "Refills need a total request limit",
				path: ["remaining"],
			});
		}
	});

type FormValues = z.infer<typeof formSchema>;

const EXPIRATION_OPTIONS = [
	{ label: "Never", value: "0" },
	{ label: "1 day", value: String(60 * 60 * 24) },
	{ label: "7 days", value: String(60 * 60 * 24 * 7) },
	{ label: "30 days", value: String(60 * 60 * 24 * 30) },
	{ label: "90 days", value: String(60 * 60 * 24 * 90) },
	{ label: "1 year", value: String(60 * 60 * 24 * 365) },
];

const TIME_WINDOW_OPTIONS = [
	{ label: "1 minute", value: String(60 * 1000) },
	{ label: "5 minutes", value: String(5 * 60 * 1000) },
	{ label: "15 minutes", value: String(15 * 60 * 1000) },
	{ label: "30 minutes", value: String(30 * 60 * 1000) },
	{ label: "1 hour", value: String(60 * 60 * 1000) },
	{ label: "1 day", value: String(24 * 60 * 60 * 1000) },
];

const REFILL_INTERVAL_OPTIONS = [
	{ label: "1 hour", value: String(60 * 60 * 1000) },
	{ label: "6 hours", value: String(6 * 60 * 60 * 1000) },
	{ label: "12 hours", value: String(12 * 60 * 60 * 1000) },
	{ label: "1 day", value: String(24 * 60 * 60 * 1000) },
	{ label: "7 days", value: String(7 * 24 * 60 * 60 * 1000) },
	{ label: "30 days", value: String(30 * 24 * 60 * 60 * 1000) },
];

export const AddApiKey = () => {
	const open = true;
	const router = useRouter();
	const [showSuccessModal, setShowSuccessModal] = useState(false);
	const [newApiKey, setNewApiKey] = useState("");
	const [summary, setSummary] = useState("");
	const [isPending, setIsPending] = useState(false);
	const { active } = useOrganization();
	const organizations = useOrganizations();
	const createApiKey = useAction(api.platform.apiKeys.create);

	const form = useForm<FormValues>({
		resolver: zodResolver(formSchema),
		defaultValues: {
			name: "",
			prefix: "",
			expiresIn: null,
			organizationId: active.id,
			rateLimitEnabled: false,
			rateLimitTimeWindow: null,
			rateLimitMax: null,
			remaining: null,
			refillAmount: null,
			refillInterval: null,
		},
	});

	const rateLimitEnabled = form.watch("rateLimitEnabled");

	useEffect(() => {
		if (open && !form.getValues("organizationId")) {
			form.setValue("organizationId", active.id);
		}
	}, [open, active.id, form]);

	const onSubmit = async (values: FormValues) => {
		setIsPending(true);
		try {
			const data = await createApiKey({
				name: values.name,
				organizationId: values.organizationId,
				expiresAt: values.expiresIn
					? Date.now() + values.expiresIn * 1000
					: undefined,
				prefix: values.prefix || undefined,
				rateLimit:
					values.rateLimitEnabled &&
					values.rateLimitTimeWindow &&
					values.rateLimitMax
						? {
								timeWindowMs: values.rateLimitTimeWindow,
								max: values.rateLimitMax,
							}
						: undefined,
				requestLimit: values.remaining
					? {
							remaining: values.remaining,
							refillAmount: values.refillAmount || undefined,
							refillIntervalMs: values.refillInterval || undefined,
						}
					: undefined,
			});
			setNewApiKey(data.key);
			setSummary(
				[
					values.expiresIn
						? `Expires ${new Date(Date.now() + values.expiresIn * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
						: "Never expires",
					values.rateLimitEnabled && values.rateLimitMax
						? `${values.rateLimitMax} requests per window`
						: "No rate limit",
				].join(" · "),
			);
			setShowSuccessModal(true);
			form.reset();
		} catch (error) {
			toast.error(errorMessage(error) || "Failed to generate API key");
		} finally {
			setIsPending(false);
		}
	};

	return (
		<>
			<div className="flex w-full flex-col gap-6 pb-10">
				<div className="space-y-1">
					<BackLink
						href="/settings/api-keys"
						label="API keys"
						onEscape={false}
						className="mb-3"
					/>
					<h1 className="text-h3">Create key</h1>
				</div>
				<Form {...form}>
					<form
						method="post"
						onSubmit={form.handleSubmit(onSubmit)}
						className="flex flex-col gap-8"
					>
						<div className="grid gap-4 sm:grid-cols-2">
							<FormField
								control={form.control}
								name="name"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Name</FormLabel>
										<FormControl>
											<Input
												placeholder="CI deploys"
												maxLength={API_KEY_NAME_MAX_LENGTH}
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="prefix"
								render={({ field }) => (
									<FormItem>
										<FormLabel>
											Prefix
											<span className="font-normal text-muted-foreground">
												optional
											</span>
										</FormLabel>
										<FormControl>
											<Input placeholder="ci" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="expiresIn"
								render={({ field }) => (
									<FormItem className="[&>button:has(+input:last-child)]:mb-0">
										<FormLabel>Expiration</FormLabel>
										<Select
											value={field.value?.toString() || "0"}
											onValueChange={(value) =>
												field.onChange(Number.parseInt(value, 10))
											}
										>
											<FormControl>
												<SelectTrigger className="w-full">
													<SelectValue placeholder="Select expiration time" />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												{EXPIRATION_OPTIONS.map((option) => (
													<SelectItem key={option.value} value={option.value}>
														{option.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="organizationId"
								render={({ field }) => (
									<FormItem className="[&>button:has(+input:last-child)]:mb-0">
										<FormLabel>Organization</FormLabel>
										<Select
											names="organization"
											value={field.value}
											onValueChange={field.onChange}
										>
											<FormControl>
												<SelectTrigger className="w-full">
													<SelectValue placeholder="Select organization" />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												{organizations?.map((org) => (
													<SelectItem key={org.id} value={org.id}>
														{org.name}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										<FormMessage />
									</FormItem>
								)}
							/>
						</div>
						<section className="flex flex-col gap-4 border-border border-t pt-8">
							<FormField
								control={form.control}
								name="rateLimitEnabled"
								render={({ field }) => (
									<FormItem className="flex flex-row items-start justify-between gap-4 space-y-0">
										<div className="space-y-1">
											<h2>
												<FormLabel className="font-semibold text-[15px] leading-normal">
													Rate limit
												</FormLabel>
											</h2>
											<FormDescription>
												Cap how many requests the key can make in a time window.
											</FormDescription>
										</div>
										<FormControl>
											<Switch
												checked={field.value}
												onCheckedChange={field.onChange}
											/>
										</FormControl>
									</FormItem>
								)}
							/>

							{rateLimitEnabled && (
								<div className="grid gap-4 sm:grid-cols-2">
									<FormField
										control={form.control}
										name="rateLimitTimeWindow"
										render={({ field }) => (
											<FormItem className="[&>button:has(+input:last-child)]:mb-0">
												<FormLabel>Time window</FormLabel>
												<Select
													value={field.value?.toString()}
													onValueChange={(value) =>
														field.onChange(Number.parseInt(value, 10))
													}
												>
													<FormControl>
														<SelectTrigger className="w-full">
															<SelectValue placeholder="Select time window" />
														</SelectTrigger>
													</FormControl>
													<SelectContent>
														{TIME_WINDOW_OPTIONS.map((option) => (
															<SelectItem
																key={option.value}
																value={option.value}
															>
																{option.label}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="rateLimitMax"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Maximum requests</FormLabel>
												<FormControl>
													<Input
														type="number"
														placeholder="100"
														value={field.value?.toString() ?? ""}
														onChange={(e) =>
															field.onChange(
																e.target.value
																	? Number.parseInt(e.target.value, 10)
																	: null,
															)
														}
													/>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
								</div>
							)}
						</section>

						<section className="flex flex-col gap-4 border-border border-t pt-8">
							<div className="space-y-1">
								<h2 className="font-semibold text-[15px]">Request quota</h2>
								<p className="text-muted-foreground text-sm">
									A total the key can spend, topped up on a schedule. Leave
									empty for unlimited.
								</p>
							</div>
							<div className="grid gap-4 sm:grid-cols-3">
								<FormField
									control={form.control}
									name="remaining"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Total requests</FormLabel>
											<FormControl>
												<Input
													type="number"
													placeholder="Unlimited"
													value={field.value?.toString() ?? ""}
													onChange={(e) =>
														field.onChange(
															e.target.value
																? Number.parseInt(e.target.value, 10)
																: null,
														)
													}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>

								<FormField
									control={form.control}
									name="refillAmount"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Refill amount</FormLabel>
											<FormControl>
												<Input
													type="number"
													placeholder="1000"
													value={field.value?.toString() ?? ""}
													onChange={(e) =>
														field.onChange(
															e.target.value
																? Number.parseInt(e.target.value, 10)
																: null,
														)
													}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>

								<FormField
									control={form.control}
									name="refillInterval"
									render={({ field }) => (
										<FormItem className="[&>button:has(+input:last-child)]:mb-0">
											<FormLabel>Refill interval</FormLabel>
											<Select
												value={field.value?.toString()}
												onValueChange={(value) =>
													field.onChange(Number.parseInt(value, 10))
												}
											>
												<FormControl>
													<SelectTrigger className="w-full">
														<SelectValue placeholder="Never" />
													</SelectTrigger>
												</FormControl>
												<SelectContent>
													{REFILL_INTERVAL_OPTIONS.map((option) => (
														<SelectItem key={option.value} value={option.value}>
															{option.label}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
											<FormMessage />
										</FormItem>
									)}
								/>
							</div>
						</section>

						<div className="flex justify-end gap-2 border-border border-t pt-4">
							<Button
								type="button"
								variant="ghost"
								onClick={() => router.push("/settings/api-keys")}
							>
								Cancel
							</Button>
							<Button type="submit" isLoading={isPending}>
								Create key
							</Button>
						</div>
					</form>
				</Form>
			</div>

			<Dialog
				open={showSuccessModal}
				onOpenChange={(next) => {
					setShowSuccessModal(next);
					if (!next) router.push("/settings/api-keys");
				}}
			>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Copy your new key</DialogTitle>
						<DialogDescription>
							This is the only time it&apos;s shown; store it in your CI secrets
							now.
						</DialogDescription>
					</DialogHeader>
					<div className="flex items-center gap-2 rounded-lg bg-foreground py-1.5 pr-1.5 pl-3 text-background">
						<code className="min-w-0 flex-1 truncate font-mono text-[13px]">
							{newApiKey}
						</code>
						<Button
							size="sm"
							variant="outline"
							onClick={() => {
								copy(newApiKey);
								toast.success("API key copied");
							}}
						>
							<CopyIcon data-icon="inline-start" />
							Copy
						</Button>
					</div>
					<pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 font-mono text-[13px] text-muted-foreground">{`curl ${typeof window === "undefined" ? "" : window.location.origin}/api/v1/projects \\
  -H "x-api-key: $PANARA_CLOUD_KEY"`}</pre>
					<DialogFooter className="items-center sm:justify-between">
						<span className="text-muted-foreground text-sm">{summary}</span>
						<Button
							onClick={() => {
								setShowSuccessModal(false);
								router.push("/settings/api-keys");
							}}
						>
							I&apos;ve saved it
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
};
