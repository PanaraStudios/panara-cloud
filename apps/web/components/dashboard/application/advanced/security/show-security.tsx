"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import { LockKeyhole, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { ToggleVisibilityInput } from "@/components/shared/toggle-visibility-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HandleSecurity } from "./handle-security";

interface Props {
	applicationId: string;
}

export const ShowSecurity = ({ applicationId }: Props) => {
	const users = useQuery(api.infra.basicAuth.listByOwner, {
		owner: { kind: "application", id: applicationId },
	});
	// Only password hashes are stored, so the password itself is never shown.
	const data = users && {
		security: users.map((user) => ({
			securityId: user._id,
			username: user.username,
			password: "********",
		})),
	};

	const deleteSecurity = useMutation(api.infra.basicAuth.remove);
	const [isRemoving, setIsRemoving] = useState(false);
	return (
		<section className="flex min-w-0 flex-col gap-4">
			<div className="flex flex-row flex-wrap items-start justify-between gap-3">
				<div>
					<h2 className="font-semibold text-[15px]">Security</h2>
					<p className="text-muted-foreground text-sm">
						Add basic auth to your application
					</p>
				</div>

				{data && data?.security.length > 0 && (
					<HandleSecurity applicationId={applicationId}>
						Add security
					</HandleSecurity>
				)}
			</div>
			<div className="flex flex-col gap-4">
				{data?.security.length === 0 ? (
					<div className="flex w-full flex-col items-center justify-center gap-3 pt-10">
						<LockKeyhole className="size-8 text-muted-foreground" />
						<span className="text-base text-muted-foreground">
							No security configured
						</span>
						<HandleSecurity applicationId={applicationId}>
							Add security
						</HandleSecurity>
					</div>
				) : (
					<div className="flex flex-col pt-2">
						<div className="flex flex-col gap-6 ">
							{data?.security.map((security) => (
								<div key={security.securityId}>
									<div className="flex w-full flex-col md:flex-row justify-between md:items-center gap-4 md:gap-10 border rounded-lg p-4">
										<div className="grid grid-cols-1 md:grid-cols-2 flex-col gap-4 md:gap-8">
											<div className="flex flex-col gap-2">
												<Label>Username</Label>
												<Input disabled value={security.username} />
											</div>
											<div className="flex flex-col gap-2">
												<Label>Password</Label>
												<ToggleVisibilityInput
													value={security.password}
													disabled
												/>
											</div>
										</div>
										<div className="flex flex-row gap-2">
											<HandleSecurity
												securityId={security.securityId}
												applicationId={applicationId}
											/>
											<DialogAction
												title="Delete Security"
												description="Are you sure you want to delete this security?"
												type="destructive"
												onClick={async () => {
													setIsRemoving(true);
													await deleteSecurity({
														userId: security.securityId,
													})
														.then(() => {
															toast.success("Security deleted successfully");
														})
														.catch(() => {
															toast.error("Error deleting security");
														})
														.finally(() => setIsRemoving(false));
												}}
											>
												<Button
													variant="ghost"
													size="icon"
													isLoading={isRemoving}
												>
													<Trash2 className="size-4 text-muted-foreground" />
												</Button>
											</DialogAction>
										</div>
									</div>
								</div>
							))}
						</div>
					</div>
				)}
			</div>
		</section>
	);
};
