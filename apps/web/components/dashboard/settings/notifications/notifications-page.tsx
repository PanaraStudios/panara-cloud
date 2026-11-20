"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useOrganization } from "@/lib/organization";
import { ShowNotifications } from "./show-notifications";

// Notification settings page: owners and admins only.
export const NotificationsPage = () => {
	const router = useRouter();
	const { canManage } = useOrganization();

	useEffect(() => {
		if (!canManage) router.replace("/");
	}, [canManage, router]);

	if (!canManage) return null;
	return <ShowNotifications />;
};
