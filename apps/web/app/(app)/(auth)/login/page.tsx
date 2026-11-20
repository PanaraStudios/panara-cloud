import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "@/components/auth/login-form";
import { redirectIfSignedIn } from "@/lib/auth/server";
import { safeNext } from "@/lib/next-path";

export const metadata: Metadata = { title: "Sign in" };

export default async function Page({
	searchParams,
}: {
	searchParams: Promise<{ next?: string | string[] }>;
}) {
	const { next } = await searchParams;
	await redirectIfSignedIn(safeNext(typeof next === "string" ? next : null));
	return (
		<Suspense>
			<LoginForm />
		</Suspense>
	);
}
