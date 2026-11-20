"use client";

import { api } from "@panara-cloud/backend/api";
import { useQuery } from "convex/react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useOrganization } from "@/lib/organization";

const examples = [
	"Make a personal blog",
	"Add a photo studio portfolio",
	"Create a personal ad blocker",
	"Build a social media dashboard",
	"Sendgrid service opensource analogue",
];

export const StepOne = ({ setTemplateInfo, templateInfo }: any) => {
	// Get servers from the API
	const { active } = useOrganization();
	const servers = useQuery(api.servers.list, {
		organizationId: active.id,
	})?.filter((server) => server.sshKeyId);
	const hasServers = servers && servers.length > 0;
	const shouldShowServerDropdown = hasServers;

	const handleExampleClick = (example: string) => {
		setTemplateInfo({ ...templateInfo, userInput: example });
	};
	return (
		<div className="flex flex-col gap-4">
			<div>
				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-2">
						<Label htmlFor="user-needs">What do you need?</Label>
						<Textarea
							id="user-needs"
							placeholder="The kind of stack, what it's for, and anything it must include."
							value={templateInfo?.userInput}
							onChange={(e) =>
								setTemplateInfo({ ...templateInfo, userInput: e.target.value })
							}
							className="min-h-32"
						/>
					</div>

					{shouldShowServerDropdown && (
						<div className="flex flex-col gap-2">
							<Label htmlFor="server-deploy">
								Server
								<span className="font-normal text-muted-foreground">
									optional
								</span>
							</Label>
							<Select
								value={templateInfo.server?.serverId || "local"}
								onValueChange={(value) => {
									if (value === "local") {
										setTemplateInfo({
											...templateInfo,
											server: undefined,
										});
									} else {
										const server = servers?.find((s) => s._id === value);
										if (server) {
											setTemplateInfo({
												...templateInfo,
												server: { serverId: server._id, name: server.name },
											});
										}
									}
								}}
							>
								<SelectTrigger id="server-deploy" className="w-full sm:w-1/2">
									<SelectValue placeholder="Panara Cloud" />
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										<SelectItem value="local">
											<span className="flex items-center gap-2 justify-between w-full">
												<span>Panara Cloud</span>
												<span className="text-muted-foreground text-xs self-center">
													Default
												</span>
											</span>
										</SelectItem>
										{servers?.map((server) => (
											<SelectItem key={server._id} value={server._id}>
												{server.name}
											</SelectItem>
										))}
										<SelectLabel>
											Servers ({(servers?.length ?? 0) + 1})
										</SelectLabel>
									</SelectGroup>
								</SelectContent>
							</Select>
						</div>
					)}

					<div className="flex flex-col gap-2">
						<Label>Examples</Label>
						<div className="flex flex-wrap gap-2">
							{examples.map((example, index) => (
								<Button
									key={index}
									variant="outline"
									size="sm"
									onClick={() => handleExampleClick(example)}
								>
									{example}
								</Button>
							))}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};
