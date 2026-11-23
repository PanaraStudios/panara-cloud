"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { errorMessage } from "@/lib/auth/errors";

// Authorizing happens on the provider's own site. This tab goes there: a tab
// opened once the URL has arrived is what popup blockers swallow.
export const goToAuthorization = async (
	authorizeUrl: () => Promise<string>,
) => {
	window.location.assign(await authorizeUrl());
};

const LIST = "/settings/git";

const untilOnList = async () => {
	for (let i = 0; i < 40 && window.location.pathname !== LIST; i++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
};

/** After a provider is saved: straight on to its authorize page. */
export const useAuthorizeAfterSave = (label: string) => {
	const router = useRouter();
	return async (authorizeUrl: () => Promise<string>) => {
		const id = "git-provider-saved";
		toast.success(`${label} saved. Opening ${label} to authorize it.`, { id });
		// The list takes the form's place in history first, so Back from the
		// provider's site doesn't land on a form that would save a second copy.
		router.replace(LIST);
		const authorize = async () => {
			try {
				await goToAuthorization(async () => {
					const url = await authorizeUrl();
					await untilOnList();
					return url;
				});
			} catch (error) {
				toast.error(`${label} saved. Authorize it to finish connecting.`, {
					id,
					description: errorMessage(error),
					action: { label: "Authorize", onClick: () => void authorize() },
				});
			}
		};
		await authorize();
	};
};
