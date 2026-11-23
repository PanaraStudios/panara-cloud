"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { CodeEditor } from "@/components/shared/code-editor";
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
import { errorMessage } from "@/lib/auth/errors";
import { useWaitForOp } from "./host-jobs";

interface Props {
	serverId: string;
}

const schema = z.object({
	command: z.string().min(1, {
		message: "Command is required",
	}),
});

type Schema = z.infer<typeof schema>;

export const EditScript = ({ serverId }: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const id = serverId as Id<"servers">;
	const customScript = useQuery(
		api.servers.getSetupScript,
		serverId && isOpen ? { serverId: id } : "skip",
	);
	const setSetupScript = useMutation(api.servers.setSetupScript);
	const requestDefault = useMutation(api.servers.requestDefaultSetupScript);
	const waitForOp = useWaitForOp();
	const [isPending, setIsPending] = useState(false);
	const [defaultCommand, setDefaultCommand] = useState<string | undefined>();

	useEffect(() => {
		if (!serverId || !isOpen || defaultCommand !== undefined) return;
		let cancelled = false;
		requestDefault({ serverId: id })
			.then((jobId) => waitForOp<string>(jobId))
			.then((script) => {
				if (!cancelled) setDefaultCommand(script);
			})
			.catch((error) => {
				if (!cancelled) {
					toast.error("Error loading the default script", {
						description: errorMessage(error),
					});
				}
			});
		return () => {
			cancelled = true;
		};
	}, [serverId, id, isOpen, defaultCommand, requestDefault, waitForOp]);

	const form = useForm<Schema>({
		defaultValues: {
			command: "",
		},
		resolver: zodResolver(schema),
	});

	useEffect(() => {
		if (customScript !== undefined) {
			form.reset({
				command: customScript || defaultCommand,
			});
		}
	}, [customScript, defaultCommand]);

	const onSubmit = async (formData: Schema) => {
		setIsPending(true);
		await setSetupScript({
			serverId: id,
			// Saving the unchanged default keeps following future defaults.
			script: formData.command === defaultCommand ? "" : formData.command,
		})
			.then(() => {
				toast.success("Script modified successfully");
			})
			.catch((error) => {
				toast.error("Error modifying the script", {
					description: errorMessage(error),
				});
			})
			.finally(() => setIsPending(false));
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger render={<Button variant="outline" />}>
				Edit setup script
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-5xl overflow-x-hidden">
				<DialogHeader>
					<DialogTitle>Setup script</DialogTitle>
					<DialogDescription>
						Modify the script which install everything necessary to deploy
						applications on your server,
					</DialogDescription>

					<AlertBlock type="warning">
						We recommend not modifying this script unless you know what you are
						doing.
					</AlertBlock>
				</DialogHeader>
				<div className="grid gap-4">
					<Form {...form}>
						<form
							method="post"
							onSubmit={form.handleSubmit(onSubmit)}
							id="hook-form-delete-application"
							className="grid w-full gap-4"
						>
							<FormField
								control={form.control}
								name="command"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Command</FormLabel>
										<FormControl className="max-h-[75vh] max-w-240 overflow-y-scroll overflow-x-hidden">
											<CodeEditor
												language="shell"
												wrapperClassName="font-mono"
												{...field}
												placeholder={`
set -e
echo "Hello world"
`}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						</form>
					</Form>
				</div>
				<DialogFooter className="flex justify-between w-full">
					<Button
						variant="outline"
						onClick={() => {
							form.reset({
								command: defaultCommand || "",
							});
						}}
					>
						Reset
					</Button>
					<Button
						isLoading={isPending}
						form="hook-form-delete-application"
						type="submit"
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
