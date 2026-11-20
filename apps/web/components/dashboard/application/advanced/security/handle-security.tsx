"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useQuery } from "convex/react";
import { PenBoxIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { FormError } from "../../form-kit";

const AddSecuritychema = z.object({
	username: z.string().min(1, "Username is required"),
	password: z.string().min(1, "Password is required"),
});

type AddSecurity = z.infer<typeof AddSecuritychema>;

interface Props {
	applicationId: string;
	securityId?: string;
	children?: React.ReactNode;
}

export const HandleSecurity = ({
	applicationId,
	securityId,
	children = <PlusIcon className="h-4 w-4" />,
}: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const owner = { kind: "application" as const, id: applicationId };
	const users = useQuery(
		api.infra.basicAuth.listByOwner,
		securityId ? { owner } : "skip",
	);
	// Passwords are stored hashed: editing a user sets a new password.
	const user = users?.find((user) => user._id === securityId);
	const data = useMemo(
		() => user && { username: user.username, password: "" },
		[user],
	);
	const createUser = useAction(api.infra.basicAuth.create);
	const updateUser = useAction(api.infra.basicAuth.update);
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const isError = error !== null;

	const form = useForm<AddSecurity>({
		defaultValues: {
			username: "",
			password: "",
		},
		resolver: zodResolver(AddSecuritychema),
	});

	useEffect(() => {
		form.reset({
			username: data?.username || "",
			password: data?.password || "",
		});
	}, [form, form.reset, form.formState.isSubmitSuccessful, data]);

	const onSubmit = async (data: AddSecurity) => {
		setIsPending(true);
		setError(null);
		await (securityId
			? updateUser({ userId: securityId as Id<"basicAuthUsers">, ...data })
			: createUser({ owner, ...data })
		)
			.then(() => {
				toast.success(securityId ? "Security Updated" : "Security Created");
				setIsOpen(false);
			})
			.catch((error) => {
				setError(errorMessage(error));
				toast.error(
					securityId
						? "Error updating the security"
						: "Error creating security",
				);
			})
			.finally(() => setIsPending(false));
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger
				render={
					(securityId ? (
						<Button
							variant="ghost"
							size="icon"
							className="group hover:bg-blue-500/10 "
						>
							<PenBoxIcon className="size-3.5  text-muted-foreground" />
						</Button>
					) : (
						<Button>{children}</Button>
					)) as React.ReactElement
				}
			/>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Security</DialogTitle>
					<DialogDescription>
						{securityId ? "Update" : "Add"} security to your application
					</DialogDescription>
				</DialogHeader>
				{isError && <FormError title="Couldn't save." detail={error} />}

				<Form {...form}>
					<form
						id="hook-form-add-security"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<div className="flex flex-col gap-4">
							<FormField
								control={form.control}
								name="username"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel>Username</FormLabel>
										<FormControl>
											<Input placeholder="test1" {...field} />
										</FormControl>

										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="password"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel>Password</FormLabel>
										<FormControl>
											<Input placeholder="test" type="password" {...field} />
										</FormControl>

										<FormMessage />
									</FormItem>
								)}
							/>
						</div>
					</form>

					<DialogFooter>
						<Button
							isLoading={isPending}
							form="hook-form-add-security"
							type="submit"
						>
							{securityId ? "Update" : "Create"}
						</Button>
					</DialogFooter>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
