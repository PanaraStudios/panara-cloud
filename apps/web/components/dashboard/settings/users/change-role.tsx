"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
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
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { authClient, authResult } from "@/lib/auth/client";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";

const changeRoleSchema = z.object({
	role: z.string().min(1),
});

type ChangeRoleSchema = z.infer<typeof changeRoleSchema>;

interface Props {
	memberId: string;
	currentRole: string;
	userEmail: string;
	asButton?: boolean;
}

export const ChangeRole = ({
	memberId,
	currentRole,
	userEmail,
	asButton = false,
}: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const { active } = useOrganization();
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const form = useForm<ChangeRoleSchema>({
		defaultValues: {
			role: currentRole,
		},
		resolver: zodResolver(changeRoleSchema),
	});

	useEffect(() => {
		if (isOpen) {
			form.reset({
				role: currentRole,
			});
			setError(null);
		}
	}, [form, currentRole, isOpen]);

	const onSubmit = async (data: ChangeRoleSchema) => {
		setIsPending(true);
		setError(null);
		await authResult(
			authClient.organization.updateMemberRole({
				memberId,
				role: data.role as "admin" | "member",
				organizationId: active.id,
			}),
		)
			.then(() => {
				toast.success("Role updated successfully");
				setIsOpen(false);
			})
			.catch((error) => {
				const message = errorMessage(error);
				setError(message);
				toast.error(message);
			})
			.finally(() => setIsPending(false));
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			{asButton ? (
				<DialogTrigger render={<Button variant="outline" />}>
					Change role
				</DialogTrigger>
			) : (
				<DialogTrigger
					role="menuitem"
					render={<DropdownMenuItem closeOnClick={false} />}
					nativeButton={false}
				>
					Change role
				</DialogTrigger>
			)}
			<DialogContent className="flex max-h-[85vh] flex-col overflow-y-auto overscroll-contain sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Change role</DialogTitle>
					<DialogDescription>
						For <strong>{userEmail}</strong>. The owner role can&apos;t be
						transferred.
					</DialogDescription>
				</DialogHeader>
				{error && (
					<FormError title="Couldn't change the role." message={error} />
				)}

				<Form {...form}>
					<form
						id="hook-form-change-role"
						onSubmit={form.handleSubmit(onSubmit)}
						className="w-full space-y-4"
					>
						<FormField
							control={form.control}
							name="role"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Role</FormLabel>
									<Select
										onValueChange={field.onChange}
										value={field.value ?? null}
									>
										<FormControl>
											<SelectTrigger className="w-full">
												<SelectValue placeholder="Select a role" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											<SelectItem value="admin">Admin</SelectItem>
											<SelectItem value="member">Member</SelectItem>
										</SelectContent>
									</Select>
									<FormDescription>
										Admins manage members and every setting. Members only see
										what they are granted.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
					</form>
				</Form>

				<DialogFooter>
					<Button
						isLoading={isPending}
						form="hook-form-change-role"
						type="submit"
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
