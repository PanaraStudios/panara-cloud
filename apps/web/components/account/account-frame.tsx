"use client";

import { PageTabs } from "@/components/ui-kit/page-tabs";
import { NestedPage, PageHeader } from "@/components/ui-kit/primitives";
import { accountNav } from "@/lib/navigation";

/** `/account/*`: the signed-in person's own pages, as tabs under one
    header. */
export function AccountFrame({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex w-full flex-col gap-6">
			<div className="flex flex-col gap-5">
				<PageHeader
					title="Account"
					description="Your profile and how you sign in, in every organization."
				/>
				<PageTabs
					label="Account sections"
					tabs={accountNav.map((item) => ({
						title: item.title,
						href: item.url,
					}))}
				/>
			</div>
			<NestedPage>{children}</NestedPage>
		</div>
	);
}
