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
	redisId: string;
}
export const ShowInternalRedisCredentials = ({ redisId }: Props) => {
	const data = useDatabase(redisId);
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
								<Input enableCopyButton disabled value="default" />
							</div>
							<div className="flex flex-col gap-2">
								<Label>Password</Label>
								<div className="flex flex-row gap-2 items-center">
									<ToggleVisibilityInput
										value={data?.databasePassword}
										disabled
									/>
									<UpdateDatabasePassword
										onUpdatePassword={async (newPassword) => {
											await changePassword({
												databaseId: databaseId(redisId),
												password: newPassword,
											});
											toast.success("Password updated successfully");
										}}
									/>
								</div>
							</div>
							<div className="flex flex-col gap-2">
								<Label>Internal port (container)</Label>
								<Input disabled value="6379" />
							</div>

							<div className="flex flex-col gap-2">
								<Label>Internal host</Label>
								<Input enableCopyButton disabled value={data?.appName} />
							</div>

							<div className="flex flex-col gap-2 md:col-span-2">
								<Label>Internal connection URL</Label>
								<ToggleVisibilityInput
									disabled
									value={`redis://default:${data?.databasePassword}@${data?.appName}:6379`}
								/>
							</div>
						</div>
					</div>
				</section>
			</div>
		</>
	);
};
