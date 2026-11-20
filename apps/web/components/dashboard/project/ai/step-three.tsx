"use client";

import ReactMarkdown from "react-markdown";
import { CodeEditor } from "@/components/shared/code-editor";
import type { StepProps } from "./step-two";

export const StepThree = ({ templateInfo }: StepProps) => {
	return (
		<div className="flex flex-col">
			<div>
				<div>
					<div className="flex flex-col gap-4">
						<div>
							<h3 className="font-medium text-sm">Name</h3>
							<p className="text-sm text-muted-foreground">
								{templateInfo?.details?.name}
							</p>
						</div>
						<div>
							<h3 className="font-medium text-sm">Description</h3>
							<ReactMarkdown className="text-sm text-muted-foreground">
								{templateInfo?.details?.description}
							</ReactMarkdown>
						</div>
						<div>
							<h3 className="font-medium text-sm">Server</h3>
							<p className="text-sm text-muted-foreground">
								{templateInfo?.server?.name || "Panara Cloud host"}
							</p>
						</div>
						<div className="space-y-2">
							<h3 className="font-medium text-sm">Docker Compose</h3>
							<CodeEditor
								lineWrapping
								value={templateInfo?.details?.dockerCompose}
								disabled
								className="font-mono"
							/>
						</div>
						<div>
							<h3 className="font-medium text-sm">Environment variables</h3>
							<ul className="flex flex-col gap-1">
								{templateInfo?.details?.envVariables.map(
									(
										env: {
											name: string;
											value: string;
										},
										index: number,
									) => (
										<li key={index}>
											<strong className="font-medium font-mono text-[13px]">
												{env.name}
											</strong>
											:
											<span className="ml-2 font-mono text-[13px] text-muted-foreground">
												{env.value}
											</span>
										</li>
									),
								)}
							</ul>
						</div>
						<div>
							<h3 className="font-medium text-sm">Domains</h3>
							<ul className="flex flex-col gap-1">
								{templateInfo?.details?.domains.map(
									(
										domain: {
											host: string;
											port: number;
											serviceName: string;
										},
										index: number,
									) => (
										<li key={index}>
											<strong className="font-medium font-mono text-[13px]">
												{domain.host}
											</strong>
											:
											<span className="ml-2 font-mono text-[13px] text-muted-foreground">
												{domain.port} - {domain.serviceName}
											</span>
										</li>
									),
								)}
							</ul>
						</div>
						<div>
							<h3 className="font-medium text-sm">Configuration files</h3>
							<ul className="flex flex-col gap-1">
								{templateInfo?.details?.configFiles?.map((file, index) => (
									<li key={index}>
										<strong className="font-medium font-mono text-[13px]">
											{file.filePath}
										</strong>
										:
										<span className="ml-2 font-mono text-[13px] text-muted-foreground">
											{file.content}
										</span>
									</li>
								))}
							</ul>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};
