"use client";

import { notFound } from "next/navigation";
import { AiGeneratorPage, ImportPage } from "./new-service/ai-and-import";
import { NewApplicationPage } from "./new-service/new-application";
import { NewComposePage } from "./new-service/new-compose";
import { NewDatabasePage } from "./new-service/new-database";
import { TemplatesPage } from "./new-service/templates";

const FLOWS: Record<string, () => React.ReactNode> = {
	application: NewApplicationPage,
	compose: NewComposePage,
	database: NewDatabasePage,
	template: TemplatesPage,
	ai: AiGeneratorPage,
	import: ImportPage,
};

/** The create flows, each a page: `/projects/[p]/environment/[e]/new/[flow]`. */
export function NewServicePage({ flow }: { flow: string }) {
	const Flow = FLOWS[flow];
	if (!Flow) notFound();
	return <Flow />;
}
