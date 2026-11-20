"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { AlertTriangle } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import {
	DialogDescription,
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
import { Switch } from "@/components/ui/switch";
import { FormError } from "../../application/form-kit";
import { composeIdOf, useCompose, useComposeOp } from "../use-compose";

interface Props {
	composeId: string;
}

const schema = z.object({
	suffix: z.string(),
	randomize: z.boolean().optional(),
});

type Schema = z.infer<typeof schema>;

export const RandomizeCompose = ({ composeId }: Props) => {
	const id = composeIdOf(composeId);
	const preview = useComposeOp();
	const compose = preview.result ?? "";
	const error = preview.error ? { message: preview.error } : null;
	const isError = !!error;
	const convert = useMutation(api.compose.deploy.convert);

	const updateCompose = useMutation(api.compose.crud.update);

	const data = useCompose(composeId);

	const form = useForm<Schema>({
		defaultValues: {
			suffix: "",
			randomize: false,
		},
		resolver: zodResolver(schema),
	});

	useEffect(() => {
		if (data) {
			form.reset({
				suffix: data?.suffix || "",
				randomize: data?.randomize || false,
			});
		}
	}, [form, form.reset, form.formState.isSubmitSuccessful, data]);

	useEffect(() => {
		randomizeCompose().catch(() => {});
	}, [composeId]);

	const onSubmit = async (formData: Schema) => {
		await updateCompose({
			composeId: id,
			suffix: formData?.suffix || "",
			randomize: formData?.randomize || false,
		})
			.then(async () => {
				await randomizeCompose();
				toast.success("Compose updated");
			})
			.catch(() => {
				toast.error("Error randomizing the compose");
			});
	};

	const suffix = form.watch("suffix");

	// The compose file rendered with the form's suffix (a random one when
	// empty), saved or not.
	const randomizeCompose = async () => {
		await preview.run(() =>
			convert({ composeId: id, randomize: true, suffix: suffix ?? "" }),
		);
	};

	return (
		<div className="w-full">
			<DialogHeader>
				<DialogTitle>Randomize Compose (experimental)</DialogTitle>
				<DialogDescription>
					Use this in case you want to deploy the same compose file and you have
					conflicts with some property like volumes, networks, etc.
				</DialogDescription>
			</DialogHeader>
			<div className="text-sm text-muted-foreground flex flex-col gap-2">
				<span>
					This will randomize the compose file and will add a suffix to the
					property to avoid conflicts
				</span>
				<ul className="list-disc list-inside">
					<li>volumes</li>
					<li>networks</li>
					<li>services</li>
					<li>configs</li>
					<li>secrets</li>
				</ul>
				<p className="text-muted-foreground text-sm">
					When you activate this option, we will include a env `COMPOSE_PREFIX`
					variable to the compose file so you can use it in your compose file.
				</p>
			</div>
			{isError && (
				<FormError
					title="Couldn't randomize the compose file."
					detail={error?.message}
				/>
			)}
			<Form {...form}>
				<form
					onSubmit={form.handleSubmit(onSubmit)}
					id="hook-form-add-project"
					className="grid w-full gap-4"
				>
					{isError && (
						<div className="flex flex-row gap-4 rounded-lg items-center bg-red-50 p-2 dark:bg-red-950">
							<AlertTriangle className="text-red-600 dark:text-red-400" />
							<span className="text-sm text-red-600 dark:text-red-400">
								{error?.message}
							</span>
						</div>
					)}

					<div className="flex flex-col lg:flex-col  gap-4 w-full ">
						<div>
							<FormField
								control={form.control}
								name="suffix"
								render={({ field }) => (
									<FormItem className="flex flex-col justify-center max-sm:items-center w-full mt-4 space-y-2">
										<FormLabel>Suffix</FormLabel>
										<FormControl>
											<Input
												placeholder="Enter a suffix (Optional, example: prod)"
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="randomize"
								render={({ field }) => (
									<FormItem className="flex flex-row items-center justify-between gap-6 space-y-0">
										<div className="min-w-0 space-y-1">
											<FormLabel>Apply randomize</FormLabel>
											<FormDescription>
												Apply randomize to the compose file.
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

						<div className="flex flex-col lg:flex-row  gap-4 w-full items-end justify-end">
							<Button
								form="hook-form-add-project"
								type="submit"
								className="lg:w-fit"
							>
								Save
							</Button>
							<Button
								type="button"
								variant="outline"
								onClick={async () => {
									await randomizeCompose();
								}}
								className="lg:w-fit"
							>
								Random
							</Button>
						</div>
					</div>
					<pre>
						<CodeEditor
							value={compose || ""}
							language="yaml"
							readOnly
							height="50rem"
						/>
					</pre>
				</form>
			</Form>
		</div>
	);
};
