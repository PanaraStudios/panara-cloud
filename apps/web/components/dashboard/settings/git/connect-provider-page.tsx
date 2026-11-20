"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
	BitbucketIcon,
	GiteaIcon,
	GithubIcon,
	GitlabIcon,
} from "@/components/icons/data-tools-icons";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AddBitbucketProvider } from "./bitbucket/add-bitbucket-provider";
import { AddGiteaProvider } from "./gitea/add-gitea-provider";
import { AddGithubProvider } from "./github/add-github-provider";
import { AddGitlabProvider } from "./gitlab/add-gitlab-provider";

const PROVIDERS = [
	{ id: "github", label: "GitHub", Icon: GithubIcon },
	{ id: "gitlab", label: "GitLab", Icon: GitlabIcon },
	{ id: "gitea", label: "Gitea", Icon: GiteaIcon },
	{ id: "bitbucket", label: "Bitbucket", Icon: BitbucketIcon },
] as const;

type ProviderId = (typeof PROVIDERS)[number]["id"];

/** Settings › Git › Connect provider: pick a host, then its form. */
export function ConnectProviderPage() {
	const router = useRouter();
	const params = useSearchParams();
	const current = (PROVIDERS.find((p) => p.id === params.get("provider"))?.id ??
		"github") as ProviderId;
	return (
		<div className="flex w-full max-w-3xl flex-col gap-6 pb-10">
			<div className="space-y-1">
				<p className="text-muted-foreground text-sm">
					<Link href="/settings/git" className="hover:text-foreground">
						Git
					</Link>{" "}
					/
				</p>
				<h1 className="text-h3">Connect provider</h1>
			</div>
			<Tabs
				value={current}
				onValueChange={(next) =>
					router.replace(`/settings/git/new?provider=${next}`)
				}
			>
				<TabsList aria-label="Provider">
					{PROVIDERS.map((provider) => (
						<TabsTrigger key={provider.id} value={provider.id}>
							<span aria-hidden="true" className="inline-flex">
								<provider.Icon className="size-4" />
							</span>
							{provider.label}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>
			{current === "github" && <AddGithubProvider />}
			{current === "gitlab" && <AddGitlabProvider />}
			{current === "gitea" && <AddGiteaProvider />}
			{current === "bitbucket" && <AddBitbucketProvider />}
		</div>
	);
}
