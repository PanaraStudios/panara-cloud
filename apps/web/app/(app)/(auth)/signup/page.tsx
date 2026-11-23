import type { Metadata } from "next";
import { Suspense } from "react";
import { SignupForm } from "@/components/auth/signup-form";
import { redirectIfSignedIn } from "@/lib/auth/server";
import { safeNext } from "@/lib/next-path";

export const metadata: Metadata = { title: "Create your account" };

export default async function Page({
	searchParams,
}: {
	searchParams: Promise<{ next?: string | string[] }>;
}) {
	const { next } = await searchParams;
	await redirectIfSignedIn(safeNext(typeof next === "string" ? next : null));
	return (
		<Suspense>
			<SignupForm />
		</Suspense>
	);
}
