"use client";
import { authClient, authResult } from "@/lib/auth/client";
import { slugify } from "@/lib/organization";

export async function createOrganization(name: string) {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("Enter a name for the organization.");
	const organization = await authResult(
		authClient.organization.create({ name: trimmed, slug: slugify(trimmed) }),
	);
	await authResult(
		authClient.organization.setActive({ organizationId: organization.id }),
	);
	return organization;
}
