"use client";

import { useRouter } from "next/navigation";
import { AddVolumes } from "@/components/dashboard/application/advanced/volumes/add-volumes";
import { UpdateVolume } from "@/components/dashboard/application/advanced/volumes/update-volume";
import { useServiceMounts } from "@/components/dashboard/application/advanced/volumes/use-mounts";
import { AddDomain } from "@/components/dashboard/application/domains/handle-domain";
import { HandleSchedules } from "@/components/dashboard/application/schedules/handle-schedules";
import { serviceSettingsUrl } from "@/lib/navigation";
import { SubPageHeader } from "./sections/kit";
import { useServiceRef } from "./use-service-ref";

type Kind = "domains" | "volumes" | "schedules";

const NOUNS: Record<Kind, string> = {
	domains: "domain",
	volumes: "volume",
	schedules: "schedule",
};

/** Create or edit one row of a settings list as its own page
    (`settings/domains/new`, `settings/volumes/[mountId]`, …). */
export function SettingsSubPage({
	list,
	itemId,
}: {
	list: Kind;
	itemId?: string;
}) {
	const ref = useServiceRef();
	const router = useRouter();
	const mounts = useServiceMounts(
		list === "volumes" && itemId && ref ? ref.id : "",
		ref?.kind ?? "application",
	);
	if (!ref) return null;
	const back = serviceSettingsUrl(ref, list);
	const done = () => router.push(back);
	const noun = NOUNS[list];
	const title = itemId ? `Edit ${noun}` : `Add ${noun}`;
	const listTitle = list.charAt(0).toUpperCase() + list.slice(1);

	let form: React.ReactNode = null;
	if (list === "domains") {
		form = (
			<AddDomain
				id={ref.id}
				type={ref.kind as "application" | "compose"}
				domainId={itemId}
				onDone={done}
			/>
		);
	} else if (list === "schedules") {
		form = (
			<HandleSchedules
				id={ref.id}
				scheduleId={itemId}
				scheduleType={ref.kind as "application" | "compose"}
				onDone={done}
			/>
		);
	} else if (itemId) {
		const mount = mounts?.find((m) => m._id === itemId);
		form = mount ? (
			<UpdateVolume
				mountId={itemId}
				serviceId={ref.id}
				type={mount.type}
				serviceType={ref.kind}
				refetch={() => {}}
				onDone={done}
			/>
		) : null;
	} else {
		form = (
			<AddVolumes
				serviceId={ref.id}
				serviceType={ref.kind}
				refetch={() => {}}
				onDone={done}
			/>
		);
	}

	return (
		<div className="flex w-full max-w-3xl flex-col gap-6 pb-16">
			<SubPageHeader back={back} list={listTitle} title={title} />
			{form}
		</div>
	);
}
