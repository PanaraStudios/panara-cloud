import { ServiceSettingsFrame } from "@/components/service-settings/section-page";

export default function Layout({ children }: { children: React.ReactNode }) {
	return <ServiceSettingsFrame>{children}</ServiceSettingsFrame>;
}
