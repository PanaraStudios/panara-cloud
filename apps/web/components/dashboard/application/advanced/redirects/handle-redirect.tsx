"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { PenBoxIcon, PlusIcon } from "lucide-react";
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
	DialogTrigger,
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
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/auth/errors";
import { FormError } from "../../form-kit";

const AddRedirectSchema = z.object({
	regex: z.string().min(1, "Regex required"),
	permanent: z.boolean().default(false),
	replacement: z.string().min(1, "Replacement required"),
});

type AddRedirect = z.infer<typeof AddRedirectSchema>;

// Default presets
const redirectPresets = [
	// {
	// 	label: "Allow www & non-www.",
	// 	redirect: {
	// 		regex: "",
	// 		permanent: false,
	// 		replacement: "",
	// 	},
	// },
	{
		id: "to-www",
		label: "Redirect to www",
		redirect: {
			regex: "^https?://(?:www.)?(.+)",
			permanent: true,
			replacement: "https://www.${1}",
		},
	},
	{
		id: "to-non-www",
		label: "Redirect to non-www",
		redirect: {
			regex: "^https?://www.(.+)",
			permanent: true,
			replacement: "https://${1}",
		},
	},
];

interface Props {
	applicationId: string;
	redirectId?: string;
	children?: React.ReactNode;
}

export const HandleRedirect = ({
	applicationId,
	redirectId,
	children = <PlusIcon className="w-4 h-4" />,
}: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const [presetSelected, setPresetSelected] = useState("");

	const owner = { kind: "application" as const, id: applicationId };
	const redirects = useQuery(
		api.infra.redirects.listByOwner,
		redirectId ? { owner } : "skip",
	);
	const data = redirects?.find((redirect) => redirect._id === redirectId);
	const createRedirect = useMutation(api.infra.redirects.create);
	const updateRedirect = useMutation(api.infra.redirects.update);
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const isError = error !== null;

	const form = useForm({
		defaultValues: {
			permanent: false,
			regex: "",
			replacement: "",
		},
		resolver: zodResolver(AddRedirectSchema),
	});

	useEffect(() => {
		form.reset({
			permanent: data?.permanent || false,
			regex: data?.regex || "",
			replacement: data?.replacement || "",
		});
	}, [form, form.reset, form.formState.isSubmitSuccessful, data]);

	const onSubmit = async (data: AddRedirect) => {
		setIsPending(true);
		setError(null);
		await (redirectId
			? updateRedirect({ redirectId: redirectId as Id<"redirects">, ...data })
			: createRedirect({ owner, ...data })
		)
			.then(() => {
				toast.success(redirectId ? "Redirect Updated" : "Redirect Created");
				onDialogToggle(false);
			})
			.catch((error) => {
				setError(errorMessage(error));
				toast.error(
					redirectId
						? "Error updating the redirect"
						: "Error creating the redirect",
				);
			})
			.finally(() => setIsPending(false));
	};

	const onDialogToggle = (open: boolean) => {
		setIsOpen(open);
		// commented for the moment because not resetting the form if accidentally closed the dialog can be considered as a feature instead of a bug
		// setPresetSelected("");
		// form.reset();
	};

	const onPresetSelect = (presetId: string) => {
		const redirectPreset = redirectPresets.find(
			(preset) => preset.id === presetId,
		)?.redirect;
		if (!redirectPreset) return;
		const { regex, permanent, replacement } = redirectPreset;
		form.reset({ regex, permanent, replacement }, { keepDefaultValues: true });
		setPresetSelected(presetId);
	};

	return (
		<Dialog open={isOpen} onOpenChange={onDialogToggle}>
			<DialogTrigger
				render={
					(redirectId ? (
						<Button variant="ghost" size="icon" aria-label="Edit">
							<PenBoxIcon className="size-4 text-muted-foreground" />
						</Button>
					) : (
						<Button>{children}</Button>
					)) as React.ReactElement
				}
			/>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Redirects</DialogTitle>
					<DialogDescription>
						Redirects are used to redirect requests to another url.
					</DialogDescription>
				</DialogHeader>
				{isError && <FormError title="Couldn't save." detail={error} />}

				<div className="md:col-span-2">
					<Label>Presets</Label>
					<Select onValueChange={onPresetSelect} value={presetSelected}>
						<SelectTrigger className="w-full">
							<SelectValue placeholder="No preset selected" />
						</SelectTrigger>
						<SelectContent>
							{redirectPresets.map((preset) => (
								<SelectItem key={preset.label} value={preset.id}>
									{preset.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<Separator />

				<Form {...form}>
					<form
						id="hook-form-add-redirect"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<div className="flex flex-col gap-4">
							<FormField
								control={form.control}
								name="regex"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel>Regex</FormLabel>
										<FormControl>
											<Input placeholder="^http://localhost/(.*)" {...field} />
										</FormControl>

										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="replacement"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel>Replacement</FormLabel>
										<FormControl>
											<Input placeholder="http://mydomain/$1" {...field} />
										</FormControl>

										<FormMessage />
									</FormItem>
								)}
							/>

							<FormField
								control={form.control}
								name="permanent"
								render={({ field }) => (
									<FormItem className="flex flex-row items-center justify-between gap-6 space-y-0">
										<div className="min-w-0 space-y-1">
											<FormLabel>Permanent</FormLabel>
											<FormDescription>
												Set the permanent option to true to apply a permanent
												redirection.
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
						</div>
					</form>

					<DialogFooter>
						<Button
							isLoading={isPending}
							form="hook-form-add-redirect"
							type="submit"
						>
							{redirectId ? "Update" : "Create"}
						</Button>
					</DialogFooter>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
