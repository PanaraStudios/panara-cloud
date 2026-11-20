"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { Loader2, Puzzle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { FormError } from "../../application/form-kit";
import { composeIdOf, useComposeOp } from "../use-compose";

interface Props {
	composeId: string;
}

export const ShowConvertedCompose = ({ composeId }: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const convert = useMutation(api.compose.deploy.convert);
	const preview = useComposeOp();
	const compose = preview.result;
	const error = preview.error ? { message: preview.error } : null;
	const isError = !!error;
	const isPending = preview.isPending;
	// Fetch the source again and convert it as the next deploy would.
	const mutateAsync = ({ composeId }: { composeId: string }) =>
		preview.run(() =>
			convert({ composeId: composeIdOf(composeId), fetch: true }),
		);

	useEffect(() => {
		if (isOpen) {
			mutateAsync({ composeId }).catch(() => {});
		}
	}, [isOpen]);

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger
				render={<Button className="max-lg:w-full" variant="outline" />}
			>
				<Puzzle className="h-4 w-4" />
				Preview Compose
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-6xl max-h-[85vh] flex flex-col">
				<DialogHeader>
					<DialogTitle>Converted Compose</DialogTitle>
					<DialogDescription>
						Preview your docker-compose file with added domains. Note: At least
						one domain must be specified for this conversion to take effect.
					</DialogDescription>
				</DialogHeader>
				{isError && (
					<FormError
						title="Couldn't convert the compose file."
						detail={error?.message}
					/>
				)}

				{isPending ? (
					<div className="flex flex-row items-center justify-center min-h-100 border p-4 rounded-md">
						<Loader2 className="h-8 w-8 text-muted-foreground mb-2 animate-spin" />
					</div>
				) : compose?.length === 5 ? (
					<div className="border p-4 rounded-md flex flex-col items-center justify-center min-h-100">
						<Puzzle className="h-8 w-8 text-muted-foreground mb-2" />
						<span className="text-muted-foreground">
							No converted compose data available.
						</span>
					</div>
				) : (
					<>
						<div className="flex flex-row gap-2 justify-end">
							<Button
								variant="outline"
								isLoading={isPending}
								onClick={() => {
									mutateAsync({ composeId })
										.then(() => {
											toast.success("Fetched source type");
										})
										.catch((err) => {
											toast.error("Error fetching source type", {
												description: err.message,
											});
										});
								}}
							>
								Refresh <RefreshCw className="ml-2 h-4 w-4" />
							</Button>
						</div>

						<div className="flex-1 min-h-0 overflow-auto rounded-md border">
							<CodeEditor
								value={compose || ""}
								language="yaml"
								readOnly
								height="100%"
								wrapperClassName="h-full"
							/>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
};
