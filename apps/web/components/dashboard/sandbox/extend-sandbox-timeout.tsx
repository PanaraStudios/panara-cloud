"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import { useState } from "react";
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
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/auth/errors";

const schema = z.object({
	minutes: z.number().min(1).max(1440),
});

interface Props {
	sandboxId: string;
	currentTimeoutMs: number;
}

export const ExtendSandboxTimeout = ({
	sandboxId,
	currentTimeoutMs,
}: Props) => {
	const [open, setOpen] = useState(false);
	const updateTimeout = useMutation(api.live.sandboxes.updateTimeout);
	const [isPending, setIsPending] = useState(false);
	const mutateAsync = async (input: {
		sandboxId: string;
		timeoutMs: number;
	}) => {
		setIsPending(true);
		try {
			await updateTimeout({
				sandboxId: input.sandboxId as Id<"sandboxes">,
				timeoutMs: input.timeoutMs,
			});
		} finally {
			setIsPending(false);
		}
	};
	const form = useForm<z.infer<typeof schema>>({
		defaultValues: {
			minutes: Math.max(1, Math.round(currentTimeoutMs / 60_000)),
		},
		resolver: zodResolver(schema),
	});

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger render={<Button variant="outline" />}>
				Idle timeout…
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Extend timeout</DialogTitle>
					<DialogDescription>
						The sandbox will be killed this many minutes after its last
						activity.
					</DialogDescription>
				</DialogHeader>
				<Form {...form}>
					<form
						method="post"
						id="extend-sandbox-form"
						className="grid gap-4"
						onSubmit={form.handleSubmit(async (values) => {
							await mutateAsync({
								sandboxId,
								timeoutMs: Math.round(values.minutes * 60_000),
							})
								.then(async () => {
									toast.success("Timeout updated");
									setOpen(false);
								})
								.catch((error) =>
									toast.error(
										`Error updating the timeout: ${errorMessage(error)}`,
									),
								);
						})}
					>
						<FormField
							control={form.control}
							name="minutes"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Timeout (minutes)</FormLabel>
									<FormControl>
										<Input
											type="number"
											min={1}
											step={1}
											{...field}
											onChange={(event) =>
												field.onChange(event.target.valueAsNumber)
											}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					</form>
				</Form>
				<DialogFooter>
					<Button
						type="submit"
						form="extend-sandbox-form"
						isLoading={isPending}
						disabled={isPending}
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
