"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { ArrowUpRightIcon } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { DEFAULT_GITHUB_URL, resolveGithubBaseUrl } from "@/utils/github-utils";

export const AddGithubProvider = () => {
	const { active } = useOrganization();
	const beginManifest = useMutation(api.sources.github.beginManifest);
	const formRef = useRef<HTMLFormElement>(null);
	const manifestRef = useRef<HTMLInputElement>(null);
	const [isCreating, setIsCreating] = useState(false);
	const [isOrganization, setIsOrganization] = useState(false);
	const [organizationName, setOrganization] = useState("");
	const [githubUrl, setGithubUrl] = useState(DEFAULT_GITHUB_URL);

	const { baseUrl, error: githubUrlError } = resolveGithubBaseUrl(githubUrl);

	// The manifest and its single-use state come from the backend, which also
	// receives GitHub's redirect; then the form posts to GitHub as before.
	const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const form = formRef.current;
		const input = manifestRef.current;
		if (!form || !input) return;
		setIsCreating(true);
		try {
			const { formAction, manifest } = await beginManifest({
				organizationId: active.id,
				githubUrl: baseUrl,
				githubOrganization: isOrganization ? organizationName : undefined,
			});
			input.value = manifest;
			form.action = formAction;
			form.submit();
		} catch (error) {
			toast.error(errorMessage(error));
			setIsCreating(false);
		}
	};

	return (
		<div className="flex flex-col">
			<section className="flex gap-4 border-border border-b pb-6">
				<StepNumber n={1} active />
				<div className="flex min-w-0 flex-1 flex-col gap-4">
					<div className="space-y-1">
						<h2 className="font-semibold text-[15px]">
							Where the repositories live
						</h2>
						<p className="text-muted-foreground text-sm">
							Panara Cloud creates a GitHub App for you, so there&apos;s no
							token to paste.
						</p>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="flex flex-col gap-2">
							<Label htmlFor="github-url">GitHub URL</Label>
							<Input
								id="github-url"
								placeholder={DEFAULT_GITHUB_URL}
								value={githubUrl}
								onChange={(e) => setGithubUrl(e.target.value)}
							/>
							<span className="text-muted-foreground text-sm">
								Change only for GitHub Enterprise.
							</span>
							{githubUrlError && (
								<span className="text-destructive text-sm">
									{githubUrlError}
								</span>
							)}
						</div>
						<div className="flex flex-col gap-2">
							<Label>Owner</Label>
							<Tabs
								value={isOrganization ? "org" : "personal"}
								onValueChange={(value) => setIsOrganization(value === "org")}
							>
								<TabsList aria-label="Owner" className="h-9 w-full p-0.5">
									<TabsTrigger value="personal">Personal account</TabsTrigger>
									<TabsTrigger value="org">Organization</TabsTrigger>
								</TabsList>
							</Tabs>
						</div>
					</div>
					{isOrganization && (
						<div className="flex max-w-sm flex-col gap-2">
							<Label htmlFor="github-org">Organization name</Label>
							<Input
								id="github-org"
								required
								placeholder="my-org"
								onChange={(e) => setOrganization(e.target.value)}
							/>
						</div>
					)}
					<form ref={formRef} onSubmit={onSubmit} method="post">
						<input
							ref={manifestRef}
							type="hidden"
							name="manifest"
							id="manifest"
							defaultValue=""
						/>
						<div className="flex flex-wrap items-center gap-4">
							<Button
								disabled={
									!!githubUrlError ||
									(isOrganization && organizationName.length < 1)
								}
								type="submit"
								isLoading={isCreating}
							>
								Create GitHub App on GitHub
								<ArrowUpRightIcon data-icon="inline-end" />
							</Button>
							<a
								href={
									isOrganization && organizationName
										? `${baseUrl}/organizations/${organizationName}/settings/installations`
										: `${baseUrl}/settings/installations`
								}
								className="text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
								target="_blank"
								rel="noopener noreferrer"
							>
								See apps you already have
							</a>
						</div>
					</form>
				</div>
			</section>
			<section className="flex gap-4 border-border border-b py-5 text-muted-foreground">
				<StepNumber n={2} />
				<div className="space-y-1">
					<h2 className="font-medium text-[15px]">
						Install it on repositories
					</h2>
					<p className="text-muted-foreground text-sm">
						GitHub sends you back here. Then pick all repositories or only some.
					</p>
				</div>
			</section>
			<section className="flex gap-4 border-border border-b py-5 text-muted-foreground">
				<StepNumber n={3} />
				<div className="space-y-1">
					<h2 className="font-medium text-[15px]">Who can use it</h2>
					<p className="text-muted-foreground text-sm">
						Share with organization, or keep it to yourself. You can rename it
						later.
					</p>
				</div>
			</section>
		</div>
	);
};

function StepNumber({ n, active = false }: { n: number; active?: boolean }) {
	return (
		<span
			className={
				active
					? "flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground font-medium text-background text-xs"
					: "flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground text-xs"
			}
		>
			{n}
		</span>
	);
}
