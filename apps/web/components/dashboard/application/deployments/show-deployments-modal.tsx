"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { ShowDeployments } from "./show-deployments";

interface Props {
	id: string;
	type:
		| "application"
		| "compose"
		| "schedule"
		| "server"
		| "backup"
		| "previewDeployment"
		| "volumeBackup";
	refreshToken?: string;
	children?: React.ReactNode;
}

export const ShowDeploymentsModal = ({
	id,
	type,
	refreshToken,
	children,
}: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger
				render={
					(children ? (
						children
					) : (
						<Button size="sm" variant="outline">
							View logs
						</Button>
					)) as React.ReactElement
				}
			/>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-5xl p-0">
				<ShowDeployments id={id} type={type} refreshToken={refreshToken} />
			</DialogContent>
		</Dialog>
	);
};
