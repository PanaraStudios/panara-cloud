"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import { useEffect, useId, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CopyButton } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { isDatabaseKind, type ServiceKind } from "@/lib/navigation";
import { SettingsBlock } from "../chrome";
import { useServiceBasics } from "../use-service";

const schema = z.object({
	name: z.string().min(1, { message: "Name is required" }),
	description: z.string().optional(),
});

type Values = z.infer<typeof schema>;

// Name and description, inline (the old per-kind "Modify" dialogs).
export function ServiceDetailsForm({
	kind,
	id,
	children,
}: {
	kind: ServiceKind;
	id: string;
	/** Fields of the same block that save on their own (the icon). */
	children?: React.ReactNode;
}) {
	const basics = useServiceBasics(kind, id);
	const updateApplication = useMutation(api.applications.applications.update);
	const updateCompose = useMutation(api.compose.crud.update);
	const updateDatabase = useMutation(api.databases.databases.update);
	const [saving, setSaving] = useState(false);
	const form = useForm<Values>({
		defaultValues: { name: "", description: "" },
		resolver: zodResolver(schema),
	});

	const name = basics?.name;
	const description = basics?.description;
	useEffect(() => {
		if (name !== undefined) form.reset({ name, description });
	}, [name, description, form]);

	const onSubmit = async ({ name, description = "" }: Values) => {
		setSaving(true);
		try {
			if (kind === "application") {
				await updateApplication({
					applicationId: id as Id<"applications">,
					name,
					description,
				});
			} else if (kind === "compose") {
				await updateCompose({
					composeId: id as Id<"compose">,
					name,
					description,
				});
			} else if (isDatabaseKind(kind)) {
				await updateDatabase({
					databaseId: id as Id<"databases">,
					name,
					description,
				});
			}
			toast.success("Saved");
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setSaving(false);
		}
	};

	const dirty = form.formState.isDirty;
	const formId = useId();
	return (
		<SettingsBlock title="Details">
			<Form {...form}>
				<form
					id={formId}
					onSubmit={form.handleSubmit(onSubmit)}
					className="flex flex-col gap-4"
				>
					<div className="grid items-start gap-4 sm:grid-cols-2">
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						{basics?.appName ? (
							<div className="flex flex-col gap-3">
								<Label htmlFor="service-app-name">Service name</Label>
								<InputGroup>
									<InputGroupInput
										id="service-app-name"
										readOnly
										value={basics.appName}
										className="font-mono text-[13px] text-muted-foreground"
									/>
									<InputGroupAddon align="inline-end">
										<CopyButton value={basics.appName} label="Service name" />
									</InputGroupAddon>
								</InputGroup>
							</div>
						) : null}
					</div>
					<FormField
						control={form.control}
						name="description"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Description</FormLabel>
								<FormControl>
									<Textarea
										className="min-h-16"
										placeholder="What this service does"
										{...field}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
				</form>
			</Form>
			{children}
			<div className="flex justify-end gap-2">
				{dirty ? (
					<Button type="button" variant="ghost" onClick={() => form.reset()}>
						Discard
					</Button>
				) : null}
				<Button
					type="submit"
					form={formId}
					disabled={!dirty}
					isLoading={saving}
				>
					Save
				</Button>
			</div>
		</SettingsBlock>
	);
}
