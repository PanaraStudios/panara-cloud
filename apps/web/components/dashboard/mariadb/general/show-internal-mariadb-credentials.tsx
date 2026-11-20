"use client";

import { api } from "@panara-cloud/backend/api";
import { useAction } from "convex/react";
import { toast } from "sonner";
import {
	databaseId,
	useDatabase,
} from "@/components/dashboard/database/use-database";
import { ToggleVisibilityInput } from "@/components/shared/toggle-visibility-input";
import { UpdateDatabasePassword } from "@/components/shared/update-database-password";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
	mariadbId: string;
}
export const ShowInternalMariadbCredentials = ({ mariadbId }: Props) => {
	const data = useDatabase(mariadbId);
	const changePassword = useAction(api.databases.passwords.changePassword);
	return (
		<>
			<div className="flex w-full flex-col gap-5 ">
				<section className="flex min-w-0 flex-col gap-4">
					<div className="space-y-1">
						<h2 className="font-semibold text-[15px] leading-snug">
							Internal credentials
						</h2>
					</div>
					<div className="flex w-full flex-row gap-4">
						<div className="grid w-full md:grid-cols-2 gap-4 md:gap-8">
							<div className="flex flex-col gap-2">
								<Label>User</Label>
								<Input enableCopyButton disabled value={data?.databaseUser} />
							</div>
							<div className="flex flex-col gap-2">
								<Label>Database name</Label>
								<Input enableCopyButton disabled value={data?.databaseName} />
							</div>
							<div className="flex flex-col gap-2">
								<Label>Password</Label>
								<div className="flex flex-row gap-2 items-center">
									<ToggleVisibilityInput
										disabled
										value={data?.databasePassword}
									/>
									<UpdateDatabasePassword
										onUpdatePassword={async (newPassword) => {
											await changePassword({
												databaseId: databaseId(mariadbId),
												password: newPassword,
												user: "user",
											});
											toast.success("Password updated successfully");
										}}
									/>
								</div>
							</div>
							<div className="flex flex-col gap-2">
								<Label>Root password</Label>
								<div className="flex flex-row gap-2 items-center">
									<ToggleVisibilityInput
										disabled
										value={data?.databaseRootPassword}
									/>
									<UpdateDatabasePassword
										label="Root Password"
										onUpdatePassword={async (newPassword) => {
											await changePassword({
												databaseId: databaseId(mariadbId),
												password: newPassword,
												user: "root",
											});
											toast.success("Root password updated successfully");
										}}
									/>
								</div>
							</div>
							<div className="flex flex-col gap-2">
								<Label>Internal port (container)</Label>
								<Input disabled value="3306" />
							</div>

							<div className="flex flex-col gap-2">
								<Label>Internal host</Label>
								<Input enableCopyButton disabled value={data?.appName} />
							</div>

							<div className="flex flex-col gap-2 md:col-span-2">
								<Label>Internal connection URL</Label>
								<ToggleVisibilityInput
									disabled
									value={`mariadb://${data?.databaseUser}:${data?.databasePassword}@${data?.appName}:3306/${data?.databaseName}`}
								/>
							</div>
						</div>
					</div>
				</section>
			</div>
		</>
	);
};
