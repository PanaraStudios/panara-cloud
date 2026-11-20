"use client";

import { useDatabase } from "@/components/dashboard/database/use-database";
import { ToggleVisibilityInput } from "@/components/shared/toggle-visibility-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

interface Props {
	libsqlId: string;
}
export const ShowInternalLibsqlCredentials = ({ libsqlId }: Props) => {
	const data = useDatabase(libsqlId);
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
								<Label>sqld node</Label>
								<Select value={data?.sqldNode} disabled>
									<SelectTrigger className="w-full">
										<SelectValue placeholder="Select Node type" />
									</SelectTrigger>
									<SelectContent>
										{["primary", "replica"].map((node) => (
											<SelectItem key={node} value={node}>
												{node.charAt(0).toUpperCase() + node.slice(1)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="flex flex-col gap-2">
								<Label>Password</Label>
								<div className="flex flex-row gap-4">
									<ToggleVisibilityInput
										disabled
										value={data?.databasePassword}
									/>
								</div>
							</div>

							<div className="flex flex-row gap-2">
								<div className="w-full flex flex-col gap-2">
									<Label>Internal port (container)</Label>
									<Input disabled value="8080" />
								</div>
								<div className="w-full flex flex-col gap-2">
									<Label>Internal gRPC port (container)</Label>
									<Input disabled value="5001" />
								</div>
								<div className="w-full flex flex-col gap-2">
									<Label>Internal admin port (container)</Label>
									<Input disabled value="5000" />
								</div>
							</div>
							<div className="flex flex-col gap-2">
								<Label>Internal host</Label>
								<Input enableCopyButton disabled value={data?.appName} />
							</div>
							<div className="flex flex-col gap-2">
								<Label>Namespaces</Label>
								<Select
									disabled
									defaultValue={
										data?.enableNamespaces
											? String(data?.enableNamespaces)
											: "false"
									}
								>
									<SelectTrigger className="w-full">
										<SelectValue placeholder={"false"} />
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											{["false", "true"].map((node) => (
												<SelectItem key={node} value={node}>
													{node.charAt(0).toUpperCase() + node.slice(1)}
												</SelectItem>
											))}
										</SelectGroup>
									</SelectContent>
								</Select>
							</div>

							<div className="flex flex-col gap-2 md:col-span-2">
								<Label>Internal connection URL</Label>
								<ToggleVisibilityInput
									disabled
									value={`http://${data?.databaseUser}:${data?.databasePassword}@${data?.appName}:8080`}
								/>
							</div>
							<div className="flex flex-col gap-2 md:col-span-2">
								<Label>Internal replication URL</Label>
								<ToggleVisibilityInput
									disabled
									value={`http://${data?.databaseUser}:${data?.databasePassword}@${data?.appName}:5001`}
								/>
							</div>
						</div>
					</div>
				</section>
			</div>
		</>
	);
};
