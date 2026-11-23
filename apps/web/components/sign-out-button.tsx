"use client";

import { LogOutIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { withNext } from "@/lib/next-path";

export async function signOutTo(path = "/login?notice=signed-out") {
	await authClient.signOut();
	window.location.assign(path);
}

// Sensitive changes need a recent sign-in; signing out first makes the next
// sign-in a fresh session.
export function reauthenticate(next = window.location.pathname) {
	return signOutTo(withNext("/login?notice=reauth", next));
}

export function SignOutButton({
	variant = "ghost",
	size = "sm",
	redirectTo,
	children = "Sign out",
}: {
	variant?: React.ComponentProps<typeof Button>["variant"];
	size?: React.ComponentProps<typeof Button>["size"];
	redirectTo?: string;
	children?: React.ReactNode;
}) {
	const [pending, setPending] = useState(false);
	return (
		<Button
			type="button"
			variant={variant}
			size={size}
			disabled={pending}
			onClick={async () => {
				setPending(true);
				await signOutTo(redirectTo);
			}}
		>
			<LogOutIcon data-icon="inline-start" />
			{children}
		</Button>
	);
}
